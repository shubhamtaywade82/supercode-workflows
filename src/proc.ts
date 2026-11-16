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

/** /proc is authoritative where it exists. In practice that means Linux. */
function procAvailable(): boolean {
  return process.platform === "linux" && fs.existsSync("/proc/self/stat");
}

/** Linux /proc facts about one process. Undefined when /proc is unavailable or the process has no entry. */
export interface ProcStat {
  state: string;
  pgrp: number;
  /** Start time in clock ticks since boot (field 22). Together with the PID, it identifies a process for its lifetime. */
  starttime: number;
}

export function readProcStat(pid: number): ProcStat | undefined {
  if (!procAvailable()) return undefined;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) state ppid pgrp ... starttime": comm may hold spaces and parentheses, so anchor on the last ")".
    const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { state: f[0], pgrp: Number(f[2]), starttime: Number(f[19]) };
  } catch {
    return undefined;
  }
}

/**
 * Is this process running? With /proc: it must exist, must not be a zombie (Z) or dead (X), and, if a start time is given,
 * must be the same process. A zombie has exited and only waits for its reaper, so it is not alive. Without /proc,
 * kill(pid, 0) is all there is. It cannot tell a zombie from a live process, so a zombie holder reads as alive there.
 * That fails closed: the lock blocks rather than reclaiming.
 */
export function processAlive(pid: number, starttime?: number): boolean {
  if (procAvailable()) {
    const st = readProcStat(pid);
    if (!st) return false;
    if (st.state.startsWith("Z") || st.state.startsWith("X")) return false;
    return starttime === undefined || st.starttime === starttime;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by another user
  }
}

interface Member { pid: number; state: string }

/**
 * Members of a process group with their states, from the process table. Not `kill(-pgid, 0)`: that succeeds for zombies,
 * and a killed child stays a zombie until its reaper collects it. Under a PID 1 that reaps slowly, a successfully killed
 * group would look alive for seconds, or forever.
 */
function groupMembers(pgid: number): Member[] {
  if (procAvailable()) {
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
  if (!procAvailable()) return "unverifiable";
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
 *
 * Why it is safe to call after the leader has been reaped: the leader's start time is no longer readable then, so identity
 * is carried by the kernel instead. A process-group id stays reserved while any process still uses it, so while members
 * exist, no unrelated process can take that id. Signals are sent only after members are found, so nothing is sent to an
 * empty id.
 */
export async function terminateGroup(pgid: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  signalGroup(pgid, "SIGTERM");
  if (await waitGroupGone(pgid, KILL_GRACE_MS)) return true;
  signalGroup(pgid, "SIGKILL");
  return waitGroupGone(pgid, KILL_GRACE_MS);
}

/**
 * Synchronously SIGKILLs every group this process started and has not yet seen end, then waits briefly for them to be gone.
 * Used on shutdown, before any lock is released, so that a released lock never coincides with a running agent.
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
 *
 * Every stop (abort, timeout, output overflow, or a failure after spawn) goes through one routine. It sends SIGTERM to the
 * group, then SIGKILL after the grace period, whether or not the leader has exited. A leader that traps or ignores SIGTERM
 * is therefore still ended. The promise settles only once the leader has exited and the group is empty. A stop that the
 * leader survives long after SIGKILL settles with an error rather than hanging.
 *
 * Rejects when:
 * - the group survives SIGKILL (the error names the group; treat it as possibly still writing),
 * - a group listener throws (for example, the lock could not record the group, so the group is killed first),
 * - the process fails to spawn, or fails after spawning (the group is ended first),
 * - the leader does not exit within a bounded time after a stop request.
 *
 * Scope: POSIX only. On Windows there is no process group here, and only the direct child is ended. The MCP server
 * refuses side-effecting runs there for that reason.
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
    let stopping = false; // a stop has been requested
    let exitSeen = false; // the leader has exited
    let settled = false;  // the promise has settled
    let stdout = "";
    let stderr = "";
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let escalation: NodeJS.Timeout | undefined;
    let hardStop: NodeJS.Timeout | undefined;
    let runTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      aborted = true;
      stopGroup();
    };

    /** Settles once. Clears every timer and the abort listener, so nothing outlives the run. */
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(runTimer);
      clearTimeout(escalation);
      clearTimeout(hardStop);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    /**
     * The one stop routine. SIGTERM now, SIGKILL after the grace period, regardless of whether the leader has exited. Idempotent.
     * If the leader has not exited well after SIGKILL, the run settles with an error instead of hanging.
     */
    const stopGroup = (): void => {
      if (stopping || settled) return;
      stopping = true;
      if (pgid === undefined) {
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      } else {
        signalGroup(pgid, "SIGTERM");
        escalation = setTimeout(() => signalGroup(pgid, "SIGKILL"), KILL_GRACE_MS);
      }
      hardStop = setTimeout(() => {
        if (!exitSeen) {
          settle(() => reject(failure ?? new Error(
            `${bin} did not exit within ${2 * KILL_GRACE_MS} ms of a stop request; its process group may still be running`,
          )));
        }
      }, 2 * KILL_GRACE_MS + 500);
    };

    runTimer = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { timedOut = true; stopGroup(); }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += outDecoder.write(chunk);
      if (stdout.length > maxBuffer && !overflow) {
        overflow = true;
        stopGroup();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + errDecoder.write(chunk)).slice(-STDERR_KEEP);
    });
    const closed = new Promise<void>((done) => child.once("close", () => done()));

    if (pgid !== undefined) {
      // Listeners run before the group is trusted. If one throws, the group is ended and the run fails.
      try {
        for (const l of [...LISTENERS]) l({ type: "start", pgid, leaderStart });
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
        stopGroup();
      }
    }

    child.once("error", (e) => {
      if (pgid === undefined) {
        settle(() => reject(e)); // never spawned
        return;
      }
      // Spawned, then failed: the group may still be running. End it. The exit path reports the failure.
      failure = failure ?? e;
      stopGroup();
    });

    child.once("exit", (code) => {
      exitSeen = true;
      void (async () => {
        // The leader is gone, but its children may not be. End them before reporting anything. Signalling here is safe for
        // the reason given on terminateGroup.
        const empty = pgid === undefined ? true : await terminateGroup(pgid);
        await Promise.race([closed, sleep(CLOSE_GRACE_MS)]);
        stdout += outDecoder.end();
        stderr = (stderr + errDecoder.end()).slice(-STDERR_KEEP);
        if (pgid !== undefined && empty) {
          LIVE_GROUPS.delete(pgid); // a group that survived stays tracked, so shutdown still kills it
          try {
            for (const l of [...LISTENERS]) l({ type: "end", pgid });
          } catch {
            /* the next acquirer classifies a recorded group that is gone as "empty" */
          }
        }
        settle(() => {
          if (failure) reject(failure);
          else if (!empty) reject(new Error(`process group ${pgid} survived SIGKILL; ${bin} may still be writing to the project`));
          else resolve({ code, stdout, stderr, aborted, timedOut, overflow });
        });
      })();
    });
  });
}
