import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardError } from "./guard.js";

/**
 * Cross-process run lock and turn ledger for one project. Two server processes on the same project serialize their
 * runs, and they draw from one turn budget.
 *
 * Guarantees, and what they rest on:
 * - Publication is atomic. A claim is written to a temp file and hard-linked into place, so no reader ever sees a
 *   partial record. Requires a filesystem with hard links.
 * - A lock held by a live process on this host is never reclaimed, however old it is. A run's length is not bounded by
 *   its deadline (the engine checks the deadline between steps), so age cannot prove the holder is gone. The cost of
 *   this rule: a reused PID blocks until that process exits or the file is removed. That fails closed.
 * - A lock from another host is reclaimed only after `staleRemoteMs`, since its PID means nothing here.
 * - An unreadable ledger is treated as exhausted, never reset. Reset it by deleting the file on purpose.
 *
 * Known residual: reclaiming a stale lock is rename-then-verify. If a fresh claim lands between the verify and the
 * restore, two processes can briefly both hold the lock. That needs a crash and a simultaneous start on the same stale
 * file. It is documented, not eliminated.
 */

export interface ProjectLockOptions {
  /** Age after which a lock from another host may be reclaimed. */
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
  /** Releases the lock if this claim still owns it. Idempotent. */
  release(): void;
}

interface LockRecord { pid: number; host: string; startedAt: number; token: string }
interface Ledger { windowStart: number; turns: number }

/** Release functions for every live lock in this process. */
const HELD = new Set<() => void>();
let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", () => {
    for (const release of HELD) release();
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = (): void => {
      for (const release of HELD) release();
      process.removeListener(sig, handler);
      process.kill(process.pid, sig); // restore the default disposition, then re-raise, so the process still dies
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === "EPERM"; // exists, owned by another user
  }
}

function parseRecord(raw: string): LockRecord | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof v.pid === "number" && typeof v.host === "string" && typeof v.startedAt === "number" && typeof v.token === "string") {
      return { pid: v.pid, host: v.host, startedAt: v.startedAt, token: v.token };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isStale(raw: string, lockPath: string, now: number, staleRemoteMs: number): boolean {
  const rec = parseRecord(raw);
  if (!rec) {
    // Unreadable. Atomic publication means this is damage, not a claim in progress, so judge by file age.
    try {
      return now - fs.statSync(lockPath).mtimeMs > staleRemoteMs;
    } catch {
      return true;
    }
  }
  if (rec.host === os.hostname()) return !isAlive(rec.pid); // local: liveness only, never age
  return now - rec.startedAt > staleRemoteMs;                // remote: age only
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

/** Moves a judged-stale lock aside, verifies it is the one judged, and removes it. See the residual note above. */
function reclaim(dir: string, lockPath: string, judged: string): void {
  const tomb = path.join(dir, `.stale-${randomUUID()}`);
  try {
    fs.renameSync(lockPath, tomb);
  } catch (e) {
    if (errCode(e) === "ENOENT") return; // someone else already removed it
    throw e;
  }
  if (readText(tomb) !== judged) {
    // We moved a claim published after we judged the old one. Restore it if the slot is still empty.
    try {
      fs.linkSync(tomb, lockPath);
    } catch {
      /* a newer claimant holds the slot; see the residual note */
    }
  }
  fs.rmSync(tomb, { force: true });
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
export function acquireProjectLock(projectRoot: string, opts: ProjectLockOptions): ProjectLock {
  installHooks();
  const now = opts.now ?? Date.now;
  const dir = path.join(projectRoot, ".supercode", "run");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n"); // runtime state stays out of git

  const lockPath = path.join(dir, "mcp.lock");
  const ledgerPath = path.join(dir, "ledger.json");
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: now(), token } satisfies LockRecord);

  let claimed = false;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    if (publish(dir, lockPath, body)) {
      claimed = true;
      break;
    }
    const current = readText(lockPath);
    if (current === undefined) continue; // released between our attempts
    if (!isStale(current, lockPath, now(), opts.staleRemoteMs)) {
      throw new GuardError("busy", "another supercode run is active for this project");
    }
    reclaim(dir, lockPath, current);
  }
  if (!claimed) throw new GuardError("busy", "could not take the project run lock; retry");

  const release = (): void => {
    const current = readText(lockPath);
    if (current !== undefined && parseRecord(current)?.token === token) fs.rmSync(lockPath, { force: true });
    HELD.delete(release);
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
