import { runProcess } from "./proc.js";

/**
 * Integration with an installed rtk binary (the rtk-oss edition: Apache-2.0 only). Nothing is bundled. The binary is invoked,
 * never vendored: the full edition's engine is BUSL-1.1, and the licence grant covers use of an installed binary, not
 * redistribution or linking.
 *
 * Rewrite protocol, as pinned by upstream's own tests (tests/hook_decision_protocol_test.rs and
 * tests/rewrite_exit_code_test.rs):
 *   rtk rewrite <command>
 *     0  allow: the rewritten command is on stdout
 *     1  no rewrite: the original command runs unchanged
 *     2  deny: a permission rule matched; the command must not run
 *     3  ask: the host should confirm. A headless run cannot, so the command is refused
 *   any other code: refused. The protocol does not define it, and running the command unchanged would be a guess.
 *
 * The protocol says the rewritten command must exit with the raw command's status (rewrite_exit_code_test), so a gate
 * step can read its pass or fail from the exit code. That is upstream's claim for the cases its tests pin, not a general
 * proof. The adapter gates on the exit code only, never on parsed output.
 */

export type RtkErrorKind = "unavailable" | "ask" | "denied" | "unexpected" | "rewrite-failed";

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
}

const DEFAULT_TIMEOUT_MS = 10_000;

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
      throw new RtkError("unavailable", `rtk could not be started (${this.bin}): ${e instanceof Error ? e.message : String(e)}`);
    }
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
      out = await runProcess(this.bin, ["rewrite", command], { env: this.env(), timeoutMs: this.timeoutMs });
    } catch (e) {
      throw new RtkError("unavailable", `rtk rewrite could not be run: ${e instanceof Error ? e.message : String(e)}`);
    }
    switch (out.code) {
      case 0: {
        const rewritten = out.stdout.trim();
        if (rewritten === "") throw new RtkError("rewrite-failed", "rtk rewrite exited 0 with no output; the command was not run");
        return rewritten;
      }
      case 1:
        return command;
      case 2:
        throw new RtkError("denied", "rtk denied this command under a permission rule; it was not run");
      case 3:
        throw new RtkError("ask", "rtk asks for confirmation before this command; a headless run cannot answer, so it was not run");
      default:
        throw new RtkError("unexpected", `rtk rewrite exited ${out.code}, which the protocol does not define; the command was not run`);
    }
  }
}
