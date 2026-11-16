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

/** Process groups with a child still in them. Killed on exit, on SIGINT/SIGTERM/SIGHUP, and by killLiveGroupsNow(). */
const LIVE_GROUPS = new Set<number>();
let hooksInstalled = false;

/**
 * Group lifecycle events. A holder that must survive its own crash records these durably, so a later run can find and
 * stop the groups it left behind. A "start" event carries the leader's start time when /proc can supply it.
 */
export type GroupEvent =
  | { type: "start"; pgid: number; leaderStart?: number }
  | { type: "end"; pgid: number };

const LISTENERS = new Set<(e: GroupEvent) => void>();

export function onGroupEvent(listener: (e: GroupEvent) => void): () => void {
  LISTENERS.add(listener);
  return () => {
    LISTENERS.delete(listener);
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Linux /proc facts about one process. Undefined on other platforms, or when the process is gone. */
export interface ProcStat {
  state: string;
  pgrp: number;
  /** Start time in clock ticks since boot (field 22). Together with the PID, it identifies a process for its lifetime. */
  starttime: number;
}

export function readProcStat(pid: number): ProcStat | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) state ppid pgrp ... starttime": comm may hold spaces and parentheses, so anchor on the last ")".
    const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { state: f[0], pgrp: Number(f[2]), starttime: Number(f[19]) };
  } catch {
    return undefined;
  }
}

interface Member { pid: number; state: string }

/**
 * Members of a process group with their states, from the process table. Not `kill(-pgid, 0)`: that succeeds for zombies,
 * and a killed child stays a zombie until its reaper collects it. Under a PID 1 that reaps slowly, a successfully killed
 * group would look alive for seconds, or forever.
 */
function groupMembers(pgid: number): Member[] {
  if (process.platform === "linux") {
    const members: Member[] = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const st = readProcStat(Number(entry));
      if (st && st.pgrp === pgid) members.push({ pid: Number(entry), state: st.state });
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

export type GroupStatus = "empty" | "ours" | "unverifiable";

/**
 * Classifies a process group recorded by an earlier run, before anything is signalled.
 *
 * - No live members: "empty".
 * - Leader present (zombie or running): compare its start time with the recorded one. Match: "ours". Mismatch: the
 *   recorded group is gone and its id now belongs to an unrelated process, so "empty", and nothing is signalled.
 *   No recorded start time: "unverifiable".
 * - Leader already reaped, members still running: "unverifiable". The reaped leader's start time can no longer be read,
 *   so ownership cannot be proven. Callers must refuse, not guess.
 * - No /proc (non-Linux): "unverifiable" whenever members remain.
 */
export function groupStatus(pgid: number, leaderStart?: number): GroupStatus {
  if (!groupAlive(pgid)) return "empty";
  if (process.platform !== "linux") return "unverifiable";
  const leader = readProcStat(pgid);
  if (!leader) return "unverifiable";
  if (leaderStart === undefined) return "unverifiable";
  return leader.starttime === leaderStart ? "ours" : "empty";
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
 * Resolves true only when the group is empty. Resolves false when members survive SIGKILL (for example, uninterruptible
 * sleep in the kernel), so the caller can report that honestly instead of claiming a clean stop.
 */
export async function terminateGroup(pgid: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  signalGroup(pgid, "SIGTERM");
  if (await waitGroupGone(pgid, KILL_GRACE_MS)) return true;
  signalGroup(pgid, "SIGKILL");
  return waitGroupGone(pgid, KILL_GRACE_MS);
}

/**
 * Synchronously SIGKILLs every group this process started and has not yet seen end. Used on shutdown, before any lock is
 * released, so that a released lock never coincides with a running agent.
 */
export function killLiveGroupsNow(): void {
  const pgids = [...LIVE_GROUPS];
  for (const pgid of pgids) signalGroup(pgid, "SIGKILL");
  // SIGKILL is delivered asynchronously. Wait, synchronously and briefly, for the groups to actually be gone, so that a
  // lock released right after this call cannot coincide with a still-writing agent.
  const deadline = Date.now() + 1_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const pgid of pgids) {
    while (groupAlive(pgid) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
  }
}

function installHooks(): void {
  if (hooksInstalled || !POSIX) return;
  hooksInstalled = true;
  process.on("exit", killLiveGroupsNow);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = (): void => {
      killLiveGroupsNow();
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
 *
 * Rejects when:
 * - the group survives SIGKILL (the error names the group; treat it as possibly still writing),
 * - a group listener throws (for example, the lock could not record the group, so the group is killed first),
 * - the process fails to spawn.
 *
 * Scope: POSIX only. On Windows there is no process group here, and only the direct child is ended.
 * Limit: group membership is what is guaranteed. A descendant that calls setsid or setpgid leaves the group, and it is not
 * ended. A plain background job (`&`) stays in the group, and is ended.
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
    const leaderStart = pgid === undefined ? undefined : readProcStat(pgid)?.starttime;
    if (pgid !== undefined) LIVE_GROUPS.add(pgid);

    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let aborted = false;
    let timedOut = false;
    let overflow = false;
    let failure: Error | undefined;
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

    const cleanup = (emptied: boolean): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // A group that survived stays tracked, so shutdown still kills it.
      if (pgid !== undefined && emptied) LIVE_GROUPS.delete(pgid);
    };

    if (pgid !== undefined) {
      // Listeners run before the group is trusted. If one throws, the group is killed and the run fails.
      try {
        for (const l of [...LISTENERS]) l({ type: "start", pgid, leaderStart });
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
        signalGroup(pgid, "SIGKILL");
      }
    }

    child.once("error", (e) => {
      cleanup(true);
      reject(e);
    });
    child.once("exit", (code) => {
      void (async () => {
        // The leader is gone, but its children may not be. End them before reporting anything.
        const empty = pgid === undefined ? true : await terminateGroup(pgid);
        await Promise.race([closed, sleep(CLOSE_GRACE_MS)]);
        stdout += outDecoder.end();
        stderr = (stderr + errDecoder.end()).slice(-STDERR_KEEP);
        cleanup(empty);
        if (empty && pgid !== undefined) {
          try {
            for (const l of [...LISTENERS]) l({ type: "end", pgid });
          } catch {
            /* the next acquirer classifies a recorded group that is gone as "empty" */
          }
        }
        if (failure) {
          reject(failure);
          return;
        }
        if (!empty) {
          reject(new Error(`process group ${pgid} survived SIGKILL; ${bin} may still be writing to the project`));
          return;
        }
        resolve({ code, stdout, stderr, aborted, timedOut, overflow });
      })();
    });
  });
}
