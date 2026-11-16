import { runProcess, type RunOutcome } from "./proc.js";

/**
 * Integration with an installed rtk binary (the rtk-oss edition: Apache-2.0 only). Nothing is bundled. The binary is invoked,
 * never vendored: the full edition's engine is BUSL-1.1, and the licence grant covers use of an installed binary, not
 * redistribution or linking.
 *
 * Rewrite protocol, as pinned by upstream's own tests (tests/hook_decision_protocol_test.rs, tests/rewrite_exit_code_test.rs
 * and tests/fallback_integrity_test.rs):
 *   rtk rewrite <command>
 *     0  allow: the rewritten command is on stdout
 *     1  no rewrite: the original runs only if stdout is blank, stderr is complete (not truncated), and stderr lacks the
 *        integrity marker (see INTEGRITY_MARKER). The fallback dispatcher exits 1 with that marker when its integrity check
 *        fails, and the tool is never reached. A run that was stopped (timeout, overflow, signal) is refused on any exit code.
 *     2  deny: a permission rule matched. Deny on any segment denies the whole chain. The command must not run.
 *     3  ask, which is also the default verdict: the host should confirm. A headless run cannot, so the command is refused.
 *        The default depends on the delegate host. Reported from upstream's protocol tests, not re-verified here: openclaw
 *        collapses it to allow (0), while claude, pi, hermes, opencode, omp and vibe keep 3. This adapter passes no host, and
 *        which host rtk uses when none is given is not verified here.
 *   any other code: refused. The protocol does not define it, and running the command unchanged would be a guess.
 *
 * The protocol says the rewritten command must exit with the raw command's status (rewrite_exit_code_test), so a gate
 * step can read its pass or fail from the exit code. That is upstream's claim for the cases its tests pin, not a general
 * proof. The adapter gates on the exit code only, never on parsed output.
 */

export type RtkErrorKind =
  | "unavailable"   // rtk could not be started at all (ENOENT, EACCES)
  | "ask" | "denied" | "unexpected" | "rewrite-failed" | "integrity"
  | "timeout"       // the run hit its deadline; its output is not trusted, even if it then exited 0
  | "overflow"      // stdout exceeded the adapter's buffer limit
  | "process-failed"; // the process started but did not finish cleanly: killed by a signal, group not ended, or a listener failed

export class RtkError extends Error {
  constructor(readonly kind: RtkErrorKind, message: string) {
    super(message);
    this.name = "RtkError";
  }
}

export interface RtkAdapterOptions {
  /** Path or name of the rtk binary. Default "rtk", found on PATH. */
  bin?: string;
  /** Extra environment for every rtk call. RTK_TELEMETRY_DISABLED=1 is always set. */
  env?: Record<string, string>;
  /** Limit for one probe or rewrite call, in milliseconds. */
  timeoutMs?: number;
  /** Limit on one rewrite call's stdout, in characters. Beyond it the call is refused as "overflow". Default: runProcess's limit. */
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Printed on stderr by rtk's fallback dispatcher, which exits 1, when its integrity check fails. Pinned by tests/fallback_integrity_test.rs. */
const INTEGRITY_MARKER = "hook integrity check FAILED";

/** A spawn that never started means rtk is unavailable. Any other rejection means a process ran and could not be finished cleanly. */
function spawnFailure(e: unknown, what: string): RtkError {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "EACCES"
    ? new RtkError("unavailable", `${what} could not be started: ${msg}`)
    : new RtkError("process-failed", `${what} failed while running: ${msg}`);
}

/**
 * A stopped run has no trustworthy result, even if it exited 0 on the way down, because its output may be partial. Refuse
 * before the exit code is read. Otherwise a timed-out rtk that exits 0 would have its partial rewrite used.
 */
function refuseIfStopped(out: RunOutcome, what: string): void {
  if (out.timedOut) throw new RtkError("timeout", `${what} timed out; the command was not run`);
  if (out.overflow) throw new RtkError("overflow", `${what} wrote more output than the adapter accepts; the command was not run`);
  if (out.aborted) throw new RtkError("process-failed", `${what} was aborted; the command was not run`);
  if (out.code === null) throw new RtkError("process-failed", `${what} ended by a signal without an exit code; the command was not run`);
}

export class RtkAdapter {
  private probed: Promise<void> | undefined;

  constructor(private readonly opts: RtkAdapterOptions = {}) {}

  private get bin(): string {
    return this.opts.bin ?? "rtk";
  }

  private env(): Record<string, string> {
    // Verified in upstream's test helper (tests/rewrite_shell_wrapper_test.rs), which sets this for every rtk call.
    return { ...(this.opts.env ?? {}), RTK_TELEMETRY_DISABLED: "1" };
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Once per adapter: the binary must start and exit 0 on --version. A failure is cached, so a broken install fails every
   * later step closed, without retrying a process that already failed.
   */
  probe(): Promise<void> {
    this.probed ??= this.runProbe();
    return this.probed;
  }

  private async runProbe(): Promise<void> {
    let out;
    try {
      out = await runProcess(this.bin, ["--version"], { env: this.env(), timeoutMs: this.timeoutMs });
    } catch (e) {
      throw spawnFailure(e, `rtk ${this.bin} --version`);
    }
    refuseIfStopped(out, `rtk ${this.bin} --version`);
    if (out.code !== 0) throw new RtkError("unavailable", `rtk --version exited ${out.code}; rtk is not usable`);
  }

  /**
   * The command to run in place of `command`, per the protocol above. Throws RtkError for every refusal, so the command
   * does not run.
   */
  async prepare(command: string): Promise<string> {
    await this.probe();
    let out;
    try {
      out = await runProcess(this.bin, ["rewrite", command], { env: this.env(), timeoutMs: this.timeoutMs, maxBuffer: this.opts.maxBuffer });
    } catch (e) {
      throw spawnFailure(e, "rtk rewrite");
    }
    refuseIfStopped(out, "rtk rewrite");
    switch (out.code) {
      case 0: {
        const rewritten = out.stdout.trim();
        if (rewritten === "") throw new RtkError("rewrite-failed", "rtk rewrite exited 0 with no output; the command was not run");
        return rewritten;
      }
      case 1: {
        // 1 is "no rewrite", and it is also the fallback dispatcher's "integrity check FAILED, tool never reached". Passing the
        // original through on the second reading would bypass that refusal. runProcess keeps only the last 64 Ki characters of
        // stderr, so when stderr was truncated the marker may have been lost, and its absence cannot be proven.
        if (out.stderrTruncated) {
          throw new RtkError("integrity", "rtk wrote more stderr than the adapter keeps on exit 1, so its integrity marker cannot be ruled out; the command was not run");
        }
        if (out.stderr.includes(INTEGRITY_MARKER)) {
          throw new RtkError("integrity", "rtk refused: its integrity check failed and the tool was not reached; the command was not run");
        }
        // The pinned contract is (1, ""). Whitespace carries no rewrite, so a trailing newline is tolerated. Anything else is anomalous.
        if (out.stdout.trim() !== "") {
          throw new RtkError("unexpected", "rtk rewrite exited 1 with output, which the protocol does not produce; the command was not run");
        }
        return command;
      }
      case 2:
        throw new RtkError("denied", "rtk denied this command under a permission rule; it was not run");
      case 3:
        throw new RtkError("ask", "rtk asks for confirmation before this command; a headless run cannot answer, so it was not run");
      default:
        throw new RtkError("unexpected", `rtk rewrite exited ${out.code}, which the protocol does not define; the command was not run`);
    }
  }
}
