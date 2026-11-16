import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GuardError } from "../src/guard.js";
import { acquireProjectLock } from "../src/lock.js";

const OPTS = { staleRemoteMs: 60_000, turnBudget: 100, turnWindowMs: 60_000 };
const LINUX = process.platform === "linux";
// Compiled layout: dist/test/lock.test.js -> dist/src/lock.js
const LOCK_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lock.js");

const isCode = (code: string) => (e: unknown): boolean => e instanceof GuardError && e.code === code;
const lockFile = (dir: string): string => path.join(dir, ".supercode", "run", "mcp.lock");
const ledgerFile = (dir: string): string => path.join(dir, ".supercode", "run", "ledger.json");
const fresh = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "scwf-lock-"));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function plant(dir: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(lockFile(dir)), { recursive: true });
  await writeFile(lockFile(dir), JSON.stringify(record));
}

/** Resolves at exit. If the child has already exited, resolves at once: `exit` is not replayed to a late listener. */
function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

/** A pid that belonged to a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await exited(child);
  return child.pid as number;
}

/**
 * A holder process: it takes the lock and, optionally, starts an agent-like process group that writes `agent`'s sentinel
 * one second later. The agent is a grandchild, so only a true group kill keeps it from landing.
 */
function holderScript(dir: string, mode: "exit" | "hold", agent?: string): string {
  const lines = [`import { acquireProjectLock } from ${JSON.stringify(pathToFileURL(LOCK_MODULE).href)};`];
  if (agent !== undefined) lines.push(`import { runProcess } from "@nemesis-oss/supercode-workflows";`);
  lines.push(`await acquireProjectLock(${JSON.stringify(dir)}, { staleRemoteMs: 60000, turnBudget: 100, turnWindowMs: 60000 });`);
  if (agent !== undefined) lines.push(`runProcess("sh", ["-c", ${JSON.stringify(agent)}]).catch(() => {});`);
  lines.push(`console.log("held");`);
  if (mode === "hold") lines.push(`setInterval(() => {}, 1000);`);
  return lines.join("\n");
}

const agentWrites = (flag: string): string => `sh -c "sleep 1; touch ${flag}"; true`;

function spawnHolder(code: string): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
}

function outputContains(child: ChildProcess, needle: string): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.includes(needle)) resolve();
    });
  });
}

test("a second acquire is refused while the first holds the lock, and release frees it", async () => {
  const dir = await fresh();
  const first = await acquireProjectLock(dir, OPTS);
  await assert.rejects(acquireProjectLock(dir, OPTS), isCode("busy"));
  first.release();
  assert.equal(existsSync(lockFile(dir)), false);
  (await acquireProjectLock(dir, OPTS)).release();
});

test("a lock whose local holder is dead is reclaimed", async () => {
  const dir = await fresh();
  await plant(dir, { pid: await deadPid(), host: os.hostname(), startedAt: Date.now(), token: "old" });
  const lock = await acquireProjectLock(dir, OPTS);
  assert.notEqual(JSON.parse(readFileSync(lockFile(dir), "utf8")).token, "old");
  lock.release();
});

test("a live local holder is never reclaimed, even when its record is very old", async () => {
  const dir = await fresh();
  await plant(dir, { pid: process.pid, host: os.hostname(), startedAt: Date.now() - 10 * 24 * 3600_000, token: "other" });
  await assert.rejects(acquireProjectLock(dir, OPTS), isCode("busy"));
  assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).token, "other");
});

test("a reused PID with a different start time is a dead holder", { skip: !LINUX }, async () => {
  const dir = await fresh();
  // This test process is alive under this PID, but its start time is not the recorded one: the PID was reused.
  await plant(dir, { pid: process.pid, host: os.hostname(), startedAt: Date.now(), token: "reused", start: 1 });
  (await acquireProjectLock(dir, OPTS)).release();
});

test("a holder on another host is reclaimed only after the remote window, and never while it records agent groups", async () => {
  const dir = await fresh();
  await plant(dir, { pid: 1, host: "elsewhere.invalid", startedAt: Date.now(), token: "remote-fresh", groups: [] });
  await assert.rejects(acquireProjectLock(dir, OPTS), isCode("busy"));
  await plant(dir, { pid: 1, host: "elsewhere.invalid", startedAt: Date.now() - OPTS.staleRemoteMs - 1_000, token: "remote-old", groups: [] });
  (await acquireProjectLock(dir, OPTS)).release();
  await plant(dir, {
    pid: 1, host: "elsewhere.invalid", startedAt: Date.now() - OPTS.staleRemoteMs - 1_000, token: "remote-groups",
    groups: [{ pgid: 4242 }],
  });
  await assert.rejects(acquireProjectLock(dir, OPTS), isCode("busy"));
});

test("an unreadable lock record blocks, even when old, until someone checks and deletes it", async () => {
  const dir = await fresh();
  await mkdir(path.dirname(lockFile(dir)), { recursive: true });
  await writeFile(lockFile(dir), "{not json");
  await assert.rejects(acquireProjectLock(dir, OPTS), isCode("busy"));
  unlinkSync(lockFile(dir));
  (await acquireProjectLock(dir, OPTS)).release();
});

test("release does not delete a lock that someone else now owns", async () => {
  const dir = await fresh();
  const lock = await acquireProjectLock(dir, OPTS);
  await writeFile(lockFile(dir), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now(), token: "someone-else", groups: [] }));
  lock.release();
  assert.equal(existsSync(lockFile(dir)), true);
});

test("the lock is released when its holder exits normally", async () => {
  const dir = await fresh();
  const child = spawnHolder(holderScript(dir, "exit"));
  const { code } = await exited(child);
  assert.equal(code, 0);
  assert.equal(existsSync(lockFile(dir)), false);
});

test("the lock is released on SIGTERM, and the holder still dies by that signal", async () => {
  const dir = await fresh();
  const child = spawnHolder(holderScript(dir, "hold"));
  try {
    await outputContains(child, "held");
    assert.equal(existsSync(lockFile(dir)), true);
    child.kill("SIGTERM");
    // Bounded: a holder that swallows SIGTERM must fail this test, not hang the runner.
    const outcome = await Promise.race([
      exited(child),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 5_000)),
    ]);
    if (outcome === "stuck") assert.fail("the holder ignored SIGTERM");
    assert.equal(outcome.signal, "SIGTERM");
    assert.equal(existsSync(lockFile(dir)), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("a running agent group is recorded in the lock while it runs", { skip: !LINUX }, async () => {
  const dir = await fresh();
  const flag = path.join(dir, "touched");
  const child = spawnHolder(holderScript(dir, "hold", agentWrites(flag)));
  try {
    await outputContains(child, "held");
    const rec = JSON.parse(readFileSync(lockFile(dir), "utf8")) as { groups: { pgid: number; leaderStart?: number }[] };
    assert.equal(rec.groups.length, 1);
    assert.equal(typeof rec.groups[0].pgid, "number");
    assert.equal(typeof rec.groups[0].leaderStart, "number", "the leader's start time is what later proves ownership");
  } finally {
    child.kill("SIGKILL");
    await exited(child);
  }
});

test("SIGTERM ends the agent group before the lock is released", { skip: !LINUX }, async () => {
  const dir = await fresh();
  const flag = path.join(dir, "touched");
  const child = spawnHolder(holderScript(dir, "hold", agentWrites(flag)));
  try {
    await outputContains(child, "held");
    child.kill("SIGTERM");
    const outcome = await Promise.race([
      exited(child),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 5_000)),
    ]);
    if (outcome === "stuck") assert.fail("the holder ignored SIGTERM");
    assert.equal(outcome.signal, "SIGTERM");
    assert.equal(existsSync(lockFile(dir)), false, "the lock must be released only after the agent group is gone");
    await sleep(1_500);
    assert.equal(existsSync(flag), false, "the agent must not write after shutdown");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("an orphaned agent group from a SIGKILLed holder is ended before a new run is admitted", { skip: !LINUX }, async () => {
  const dir = await fresh();
  const flag = path.join(dir, "touched");
  const child = spawnHolder(holderScript(dir, "hold", agentWrites(flag)));
  await outputContains(child, "held");
  child.kill("SIGKILL"); // no handler runs: the agent group is left behind, recorded in the lock
  await exited(child);
  const lock = await acquireProjectLock(dir, OPTS); // must end the orphan before it returns
  await sleep(1_500);
  assert.equal(existsSync(flag), false, "the orphaned agent must not write once a new run holds the project");
  lock.release();
});

test("the ledger spends its window, refuses without leaking the lock, and resets after the window", async () => {
  const dir = await fresh();
  let now = 0;
  const opts = { ...OPTS, turnBudget: 2, turnWindowMs: 1_000, now: () => now };
  const a = await acquireProjectLock(dir, opts);
  a.chargeTurn();
  a.chargeTurn();
  a.release();
  await assert.rejects(acquireProjectLock(dir, opts), isCode("budget"));
  assert.equal(existsSync(lockFile(dir)), false, "a budget refusal must release the lock");
  now = 1_001;
  const b = await acquireProjectLock(dir, opts);
  b.chargeTurn();
  b.release();
});

test("a corrupt ledger fails closed instead of resetting the budget", async () => {
  const dir = await fresh();
  await mkdir(path.dirname(ledgerFile(dir)), { recursive: true });
  await writeFile(ledgerFile(dir), "garbage");
  await assert.rejects(acquireProjectLock(dir, OPTS), isCode("budget"));
  assert.equal(existsSync(lockFile(dir)), false);
});
