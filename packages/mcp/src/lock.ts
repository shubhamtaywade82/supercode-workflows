import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  groupStatus,
  killLiveGroupsNow,
  onGroupEvent,
  processAlive,
  readProcStat,
  terminateGroup,
} from "@nemesis-oss/supercode-workflows";
import { GuardError } from "./guard.js";

/**
 * Cross-process run lock and turn ledger for one project. Two server processes on the same project serialize their runs
 * and draw from one turn budget. Lock and ledger live in <project>/.supercode/run/, which ignores itself in git.
 *
 * Guarantees, and what they rest on:
 * - Atomic publication. A claim is written to a temp file and hard-linked into place, so no reader sees a partial record.
 *   Requires a filesystem with hard links.
 * - Holder identity is PID plus start time (Linux). A reused PID has a different start time, so a dead holder is provably
 *   dead and its lock is reclaimed at once. Elsewhere, a live PID counts as the holder.
 * - Agent process groups are recorded in the lock as they start and removed as they end. Before a dead holder's lock is
 *   reclaimed, its recorded groups are ended, but only groups whose ownership can be proven (see groupStatus). A group that
 *   cannot be proven or ended blocks the new run. An orphaned agent therefore cannot run alongside a second run.
 * - Shutdown kills live groups before any lock is released, so a released lock never coincides with a running agent.
 * - A lock held by a live holder on this host is never reclaimed, however old its record. A run's length is not bounded
 *   by its deadline, so age cannot prove the holder is gone.
 * - A lock from another host is reclaimed only after `staleRemoteMs`, and never while it still records agent groups,
 *   because those groups cannot be checked from here.
 * - An unreadable lock record blocks. It cannot be checked for recorded groups, so it is never reclaimed automatically.
 * - An unreadable ledger is treated as exhausted, never reset. Repair by deleting it on purpose.
 *
 * Known residuals:
 * - Reclaim is rename-then-verify. A fresh claim that lands between verify and restore can briefly give two processes
 *   the lock. That needs a crash and a simultaneous start on the same stale file.
 * - A group whose leader was reaped while members still run is "unverifiable" and blocks until those members exit or
 *   an operator ends them.
 * - The ledger window is fixed: it starts at the first charge after the previous window expired. A project can therefore
 *   spend up to 2x the budget across a window boundary.
 * - The ledger's read-check-write is safe only because the lock serializes runs. Nothing else may charge the ledger.
 */

export interface ProjectLockOptions {
  /** Age after which a lock from another host may be reclaimed, if it records no agent groups. */
  staleRemoteMs: number;
  /** Agent turns allowed per project within one window. */
  turnBudget: number;
  /** Length of the ledger window. */
  turnWindowMs: number;
  now?: () => number;
}

export interface ProjectLock {
  readonly token: string;
  /** Charges one agent turn to the project ledger. Throws GuardError "budget" when the window is spent. */
  chargeTurn(): void;
  /** Releases the lock if this claim owns it, and no agent group it recorded is still running. Idempotent. */
  release(): void;
}

interface GroupRecord { pgid: number; leaderStart?: number }
interface LockRecord {
  pid: number;
  host: string;
  startedAt: number;
  token: string;
  /** The holder's own start time (Linux). Identifies the holder beyond its PID. */
  start?: number;
  groups: GroupRecord[];
}
interface Ledger { windowStart: number; turns: number }

/** Release functions for every live lock in this process. */
const HELD = new Set<() => void>();
let hooksInstalled = false;

/**
 * Shutdown order is fixed: kill live agent groups first, then release locks. Releasing first would let a second run
 * claim the project while the first run's agent is still writing.
 */
function shutdown(): void {
  killLiveGroupsNow();
  for (const release of [...HELD]) release();
}

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", shutdown);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = (): void => {
      shutdown();
      process.removeListener(sig, handler);
      process.kill(process.pid, sig); // restore the default disposition, then re-raise so the process still dies
    };
    process.on(sig, handler);
  }
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") return undefined;
    throw e;
  }
}

function parseRecord(raw: string): LockRecord | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockRecord> & { groups?: unknown };
    if (typeof v.pid !== "number" || typeof v.host !== "string" || typeof v.startedAt !== "number" || typeof v.token !== "string") {
      return undefined;
    }
    const groups: GroupRecord[] = [];
    if (Array.isArray(v.groups)) {
      for (const g of v.groups as Partial<GroupRecord>[]) {
        if (typeof g.pgid === "number") {
          groups.push(typeof g.leaderStart === "number" ? { pgid: g.pgid, leaderStart: g.leaderStart } : { pgid: g.pgid });
        }
      }
    }
    return {
      pid: v.pid,
      host: v.host,
      startedAt: v.startedAt,
      token: v.token,
      start: typeof v.start === "number" ? v.start : undefined,
      groups,
    };
  } catch {
    return undefined;
  }
}

/**
 * Is the recorded holder still running as the same process? A zombie holder has exited and is dead. A reused PID has a
 * different start time, so it is a different process, and the holder is gone.
 */
function holderAlive(rec: LockRecord): boolean {
  return processAlive(rec.pid, rec.start);
}

/** Ends every recorded group that is provably ours. Resolves false if any group cannot be proven or ended. */
async function clearRecordedGroups(groups: GroupRecord[]): Promise<boolean> {
  for (const g of groups) {
    const status = groupStatus(g.pgid, g.leaderStart);
    if (status === "empty") continue;
    if (status === "unverifiable") return false;
    if (!(await terminateGroup(g.pgid))) return false;
  }
  return true;
}

/** Atomically creates lockPath with the full record. False when someone else holds it. */
function publish(dir: string, lockPath: string, body: string): boolean {
  const tmp = path.join(dir, `.claim-${randomUUID()}`);
  fs.writeFileSync(tmp, body, { flag: "wx" });
  try {
    fs.linkSync(tmp, lockPath); // create-if-absent, and the record is complete before it becomes visible
    return true;
  } catch (e) {
    if (errCode(e) === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Moves a judged stale lock aside and removes it. The judged content is compared with what was moved. A mismatch means a
 * fresh claim landed after the judgement, so it is restored with a hard link, which fails when the slot is taken.
 * Restore never uses rename, so it cannot clobber a newer claim. See the residual note above.
 */
function reclaim(dir: string, lockPath: string, judged: string): void {
  const tomb = path.join(dir, `.stale-${randomUUID()}`);
  try {
    fs.renameSync(lockPath, tomb);
  } catch (e) {
    if (errCode(e) === "ENOENT") return; // someone else already removed it
    throw e;
  }
  if (readText(tomb) === judged) {
    fs.rmSync(tomb, { force: true });
    return;
  }
  // We displaced a claim published after the judgement. Put it back only if the slot is still empty. If it is not, keep the
  // displaced record on disk: deleting it would erase the evidence of the residual race.
  try {
    fs.linkSync(tomb, lockPath);
  } catch {
    throw new GuardError("busy", `a lock claim was displaced while being reclaimed and is kept at ${tomb} for inspection`);
  }
  fs.rmSync(tomb, { force: true });
}

/** Rewrites the record through a temp file and rename, but only if this claim still owns it. */
function rewriteRecord(lockPath: string, token: string, mutate: (groups: GroupRecord[]) => GroupRecord[]): void {
  const raw = readText(lockPath);
  const rec = raw === undefined ? undefined : parseRecord(raw);
  if (!rec || rec.token !== token) {
    throw new GuardError("busy", "the project lock was taken over during this run; aborting it");
  }
  const next: LockRecord = { ...rec, groups: mutate(rec.groups) };
  const tmp = path.join(path.dirname(lockPath), `.rec-${randomUUID()}`);
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, lockPath);
}

function readLedger(file: string, now: number, windowMs: number): Ledger {
  const raw = readText(file);
  if (raw === undefined) return { windowStart: now, turns: 0 };
  let parsed: Partial<Ledger>;
  try {
    parsed = JSON.parse(raw) as Partial<Ledger>;
  } catch {
    parsed = {};
  }
  if (typeof parsed.windowStart !== "number" || typeof parsed.turns !== "number") {
    throw new GuardError("budget", `project ledger is unreadable (${file}); treated as exhausted. Delete it to reset the budget on purpose`);
  }
  return now - parsed.windowStart >= windowMs
    ? { windowStart: now, turns: 0 }
    : { windowStart: parsed.windowStart, turns: parsed.turns };
}

/** Writes through a temp file and rename, so a crash mid-write cannot leave a truncated ledger. */
function writeLedger(file: string, ledger: Ledger): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger));
  fs.renameSync(tmp, file);
}

const budgetMessage = (opts: ProjectLockOptions): string =>
  `project turn budget exhausted: ${opts.turnBudget} turns per ${opts.turnWindowMs} ms window`;

/**
 * Takes the project's run lock, or throws GuardError "busy". Also refuses with "budget" if the ledger is already spent,
 * so a refused run never gets as far as consuming a confirmation token.
 */
export async function acquireProjectLock(projectRoot: string, opts: ProjectLockOptions): Promise<ProjectLock> {
  installHooks();
  const now = opts.now ?? Date.now;
  const root = fs.realpathSync(projectRoot); // symlinked spellings of one project converge on one lock
  const dir = path.join(root, ".supercode", "run");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");

  const lockPath = path.join(dir, "mcp.lock");
  const ledgerPath = path.join(dir, "ledger.json");
  const token = randomUUID();
  const holderStart = readProcStat(process.pid)?.starttime;
  const recordBody = (groups: GroupRecord[]): string => JSON.stringify({
    pid: process.pid, host: os.hostname(), startedAt: now(), token, start: holderStart, groups,
  } satisfies LockRecord);

  let claimed = false;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    if (publish(dir, lockPath, recordBody([]))) {
      claimed = true;
      break;
    }
    const current = readText(lockPath);
    if (current === undefined) continue; // released between our attempts
    const rec = parseRecord(current);
    if (!rec) {
      throw new GuardError("busy", `the project lock record is unreadable (${lockPath}); check that no run is active, then delete it`);
    }
    const stale = rec.host === os.hostname()
      ? !holderAlive(rec)
      : now() - rec.startedAt > opts.staleRemoteMs;
    if (!stale) throw new GuardError("busy", "another supercode run is active for this project");

    if (rec.host !== os.hostname()) {
      if (rec.groups.length > 0) {
        throw new GuardError("busy", "a stale lock from another host still records agent groups; they cannot be checked from here");
      }
    } else if (!(await clearRecordedGroups(rec.groups))) {
      const pgids = rec.groups.map((g) => g.pgid).join(", ");
      throw new GuardError(
        "busy",
        `agent process group(s) ${pgids} of a crashed run could not be confirmed stopped; end them, then retry`,
      );
    }
    reclaim(dir, lockPath, current);
  }
  if (!claimed) throw new GuardError("busy", "could not take the project run lock; retry");

  // Agent groups are recorded as they start and removed as they end, so a crashed holder leaves its groups on record.
  const unsubscribe = onGroupEvent((e) => {
    if (e.type === "start") {
      rewriteRecord(lockPath, token, (groups) => [
        ...groups.filter((g) => g.pgid !== e.pgid),
        e.leaderStart === undefined ? { pgid: e.pgid } : { pgid: e.pgid, leaderStart: e.leaderStart },
      ]);
    } else {
      rewriteRecord(lockPath, token, (groups) => groups.filter((g) => g.pgid !== e.pgid));
    }
  });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    unsubscribe();
    HELD.delete(release);
    const raw = readText(lockPath);
    const rec = raw === undefined ? undefined : parseRecord(raw);
    if (!rec || rec.token !== token) return;
    // Keep the record if any group it names still runs. The next acquirer must see it and clear it first.
    if (rec.groups.some((g) => groupStatus(g.pgid, g.leaderStart) !== "empty")) return;
    fs.rmSync(lockPath, { force: true });
  };
  HELD.add(release);

  try {
    if (readLedger(ledgerPath, now(), opts.turnWindowMs).turns >= opts.turnBudget) {
      throw new GuardError("budget", budgetMessage(opts));
    }
  } catch (e) {
    release();
    throw e;
  }

  return {
    token,
    chargeTurn(): void {
      const l = readLedger(ledgerPath, now(), opts.turnWindowMs);
      if (l.turns >= opts.turnBudget) throw new GuardError("budget", budgetMessage(opts));
      writeLedger(ledgerPath, { windowStart: l.windowStart, turns: l.turns + 1 });
    },
    release,
  };
}
