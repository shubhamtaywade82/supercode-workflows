import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const POSIX = process.platform !== "win32";
/** How long a group gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** How long stdio may stay open after the leader exits, before we stop waiting for it. */
const CLOSE_GRACE_MS = 1_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const STDERR_KEEP = 64 * 1024;

/** Process groups with a child still in them. Killed on exit and on SIGINT/SIGTERM/SIGHUP. */
const LIVE_GROUPS = new Set<number>();
let hooksInstalled = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Member { pid: number; state: string }

/**
 * Members of a process group with their states, read from the process table. Not `kill(-pgid, 0)`: that succeeds for
 * zombies, and a killed child stays a zombie until its reaper collects it. Under a PID 1 that reaps slowly, that made a
 * successfully killed group look alive for seconds, or forever.
 */
function groupMembers(pgid: number): Member[] {
  if (process.platform === "linux") {
    const members: Member[] = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        // "pid (comm) state ppid pgrp ...": comm may contain spaces and parentheses, so parse after the last ")".
        const raw = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pgid) members.push({ pid: Number(entry), state: fields[0] });
      } catch {
        /* exited while we were scanning */
      }
    }
    return members;
  }
  const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
  return (ps.stdout ?? "").split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && Number(f[1]) === pgid)
    .map((f) => ({ pid: Number(f[0]), state: f[2] }));
}

/** True while a member of the group is running. Zombies (Z) and dead tasks (X) have exited, so they do not count. */
function groupAlive(pgid: number): boolean {
  return groupMembers(pgid).some((m) => !m.state.startsWith("Z") && !m.state.startsWith("X"));
}

/** Best effort: ESRCH means the group is already empty. Liveness is always checked with groupAlive. */
function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* already empty */
  }
}

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/**
 * Ends every remaining member of a process group: SIGTERM, a grace period, then SIGKILL.
 * Resolves true only when the group is empty.
 */
export async function terminateGroup(pgid: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  signalGroup(pgid, "SIGTERM");
  if (await waitGroupGone(pgid, KILL_GRACE_MS)) return true;
  signalGroup(pgid, "SIGKILL");
  return waitGroupGone(pgid, KILL_GRACE_MS);
}

function installHooks(): void {
  if (hooksInstalled || !POSIX) return;
  hooksInstalled = true;
  const killAll = (): void => {
    for (const pgid of LIVE_GROUPS) signalGroup(pgid, "SIGKILL");
  };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = (): void => {
      killAll();
      process.removeListener(sig, handler); // restore the default disposition, then re-raise
      process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  maxBuffer?: number;
  /** Aborting ends the whole process group. The promise settles only after the group is empty. */
  signal?: AbortSignal;
  /** Deadline for the process. On expiry the group is ended and `timedOut` is set. */
  timeoutMs?: number;
}

export interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  overflow: boolean;
}

/**
 * Runs a process as the leader of its own process group. When this resolves, no member of that group is still running.
 * Abort, timeout, and output overflow send SIGTERM to the group, escalate to SIGKILL after a grace period, and resolve
 * only once the group is empty. Stray members left after a normal exit are ended too: a turn is over when it returns.
 * Rejects if the group survives SIGKILL, so a caller can fail closed.
 */
export function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<RunOutcome> {
  if (opts.signal?.aborted) {
    return Promise.resolve({ code: null, stdout: "", stderr: "", aborted: true, timedOut: false, overflow: false });
  }
  installHooks();
  return new Promise<RunOutcome>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      detached: POSIX, // the child becomes a process-group leader, so the group can be signalled as one
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = POSIX ? child.pid : undefined;
    if (pgid !== undefined) LIVE_GROUPS.add(pgid);

    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let aborted = false;
    let timedOut = false;
    let overflow = false;
    let stdout = "";
    let stderr = "";
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    const stopLeader = (): void => {
      if (pgid !== undefined) signalGroup(pgid, "SIGTERM");
      else child.kill("SIGTERM");
    };
    const timer = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { timedOut = true; stopLeader(); }, opts.timeoutMs);
    const onAbort = (): void => { aborted = true; stopLeader(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += outDecoder.write(chunk);
      if (stdout.length > maxBuffer && !overflow) {
        overflow = true;
        stopLeader();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + errDecoder.write(chunk)).slice(-STDERR_KEEP);
    });
    const closed = new Promise<void>((done) => child.once("close", () => done()));

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (pgid !== undefined) LIVE_GROUPS.delete(pgid);
    };

    child.once("error", (e) => {
      cleanup();
      reject(e);
    });
    child.once("exit", (code) => {
      void (async () => {
        // The leader is gone, but its children may not be. End them before reporting anything.
        const empty = pgid === undefined ? true : await terminateGroup(pgid);
        await Promise.race([closed, sleep(CLOSE_GRACE_MS)]);
        stdout += outDecoder.end();
        stderr = (stderr + errDecoder.end()).slice(-STDERR_KEEP);
        cleanup();
        if (!empty) {
          reject(new Error(`process group ${pgid} survived SIGKILL; ${bin} may still be writing to the project`));
          return;
        }
        resolve({ code, stdout, stderr, aborted, timedOut, overflow });
      })();
    });
  });
}
