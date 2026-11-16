import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GuardError } from "../src/guard.js";
import { acquireProjectLock } from "../src/lock.js";

const OPTS = { staleRemoteMs: 60_000, turnBudget: 100, turnWindowMs: 60_000 };
// Compiled layout: dist/test/lock.test.js -> dist/src/lock.js
const LOCK_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lock.js");

const isCode = (code: string) => (e: unknown): boolean => e instanceof GuardError && e.code === code;
const lockFile = (dir: string): string => path.join(dir, ".supercode", "run", "mcp.lock");
const ledgerFile = (dir: string): string => path.join(dir, ".supercode", "run", "ledger.json");
const fresh = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "scwf-lock-"));

async function plant(dir: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(lockFile(dir)), { recursive: true });
  await writeFile(lockFile(dir), JSON.stringify(record));
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

/** A pid that belonged to a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await exited(child);
  return child.pid as number;
}

test("a second acquire is refused while the first holds the lock, and release frees it", async () => {
  const dir = await fresh();
  const first = acquireProjectLock(dir, OPTS);
  assert.throws(() => acquireProjectLock(dir, OPTS), isCode("busy"));
  first.release();
  assert.equal(existsSync(lockFile(dir)), false);
  acquireProjectLock(dir, OPTS).release();
});

test("a lock whose local holder is dead is reclaimed", async () => {
  const dir = await fresh();
  await plant(dir, { pid: await deadPid(), host: os.hostname(), startedAt: Date.now(), token: "old" });
  const lock = acquireProjectLock(dir, OPTS);
  assert.notEqual(JSON.parse(readFileSync(lockFile(dir), "utf8")).token, "old");
  lock.release();
});

test("a live local holder is never reclaimed, even when its record is very old", async () => {
  const dir = await fresh();
  await plant(dir, { pid: process.pid, host: os.hostname(), startedAt: Date.now() - 10 * 24 * 3600_000, token: "other" });
  assert.throws(() => acquireProjectLock(dir, OPTS), isCode("busy"));
  assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).token, "other");
});

test("a holder on another host is reclaimed only after the remote staleness window", async () => {
  const dir = await fresh();
  await plant(dir, { pid: 1, host: "elsewhere.invalid", startedAt: Date.now(), token: "remote-fresh" });
  assert.throws(() => acquireProjectLock(dir, OPTS), isCode("busy"));
  await plant(dir, { pid: 1, host: "elsewhere.invalid", startedAt: Date.now() - OPTS.staleRemoteMs - 1_000, token: "remote-old" });
  acquireProjectLock(dir, OPTS).release();
});

test("an unreadable lock is judged by its age", async () => {
  const dir = await fresh();
  await mkdir(path.dirname(lockFile(dir)), { recursive: true });
  await writeFile(lockFile(dir), "{not json");
  assert.throws(() => acquireProjectLock(dir, OPTS), isCode("busy")); // recent file: not stale
  acquireProjectLock(dir, { ...OPTS, now: () => Date.now() + OPTS.staleRemoteMs + 60_000 }).release();
});

test("release does not delete a lock that someone else now owns", async () => {
  const dir = await fresh();
  const lock = acquireProjectLock(dir, OPTS);
  await writeFile(lockFile(dir), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now(), token: "someone-else" }));
  lock.release();
  assert.equal(existsSync(lockFile(dir)), true);
});

function holderScript(dir: string, mode: "exit" | "hold"): string {
  return [
    `import { acquireProjectLock } from ${JSON.stringify(pathToFileURL(LOCK_MODULE).href)};`,
    `acquireProjectLock(${JSON.stringify(dir)}, { staleRemoteMs: 60000, turnBudget: 100, turnWindowMs: 60000 });`,
    `console.log("held");`,
    mode === "hold" ? `setInterval(() => {}, 1000);` : "",
  ].join("\n");
}

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

test("the ledger spends its window, refuses without leaking the lock, and resets after the window", async () => {
  const dir = await fresh();
  let now = 0;
  const opts = { ...OPTS, turnBudget: 2, turnWindowMs: 1_000, now: () => now };
  const a = acquireProjectLock(dir, opts);
  a.chargeTurn();
  a.chargeTurn();
  a.release();
  assert.throws(() => acquireProjectLock(dir, opts), isCode("budget"));
  assert.equal(existsSync(lockFile(dir)), false, "a budget refusal must release the lock");
  now = 1_001;
  const b = acquireProjectLock(dir, opts);
  b.chargeTurn();
  b.release();
});

test("a corrupt ledger fails closed instead of resetting the budget", async () => {
  const dir = await fresh();
  await mkdir(path.dirname(ledgerFile(dir)), { recursive: true });
  await writeFile(ledgerFile(dir), "garbage");
  assert.throws(() => acquireProjectLock(dir, OPTS), isCode("budget"));
  assert.equal(existsSync(lockFile(dir)), false);
});
