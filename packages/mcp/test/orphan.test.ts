import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { groupStatus, readProcStat } from "@nemesis-oss/supercode-workflows";
import { acquireProjectLock } from "../src/lock.js";

const OPTS = { staleRemoteMs: 60_000, turnBudget: 100, turnWindowMs: 60_000 };
const LINUX = process.platform === "linux";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const lockFile = (dir: string): string => path.join(dir, ".supercode", "run", "mcp.lock");
const fresh = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "scwf-orphan-"));

async function plant(dir: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(lockFile(dir)), { recursive: true });
  await writeFile(lockFile(dir), JSON.stringify(record));
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** A pid that belonged to a process that has already exited and been reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await exited(child);
  return child.pid as number;
}

/**
 * A zombie: a forked child that exited while its parent sleeps without waiting for it. perl is used because sh reaps its own
 * background jobs. Returns the zombie's pid and a stop function that kills the parent, so init reaps the zombie.
 */
async function zombieChild(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const parent = spawn("perl", ["-e", 'my $p = fork(); if ($p == 0) { exit 0 } $| = 1; print "$p\\n"; sleep 5;'], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const pid = await new Promise<number>((resolve) => {
    parent.stdout.once("data", (d: Buffer) => resolve(Number(String(d).trim())));
  });
  await sleep(300);
  return {
    pid,
    stop: async () => {
      parent.kill("SIGKILL");
      await exited(parent);
    },
  };
}

test("a dead holder's recorded agent group is terminated before the new claim is published", { skip: !LINUX }, async () => {
  const dir = await fresh();
  // A live process group standing in for an orphaned agent, recorded in the lock by its dead holder.
  const orphan = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const pgid = orphan.pid as number;
  try {
    await sleep(100);
    const leaderStart = readProcStat(pgid)?.starttime as number;
    assert.equal(groupStatus(pgid, leaderStart), "ours", "precondition: the orphan group is alive and provably ours");

    await plant(dir, {
      pid: await deadPid(), host: os.hostname(), startedAt: Date.now(), token: "crashed", groups: [{ pgid, leaderStart }],
    });
    const lock = await acquireProjectLock(dir, OPTS);
    // The claim is ours, and the group is gone: nothing can write alongside the new run.
    assert.equal(groupStatus(pgid, leaderStart), "empty", "the orphan must be ended before the new claim exists");
    assert.notEqual(JSON.parse(readFileSync(lockFile(dir), "utf8")).token, "crashed");
    lock.release();
  } finally {
    orphan.kill("SIGKILL");
    await exited(orphan);
  }
});

test("a zombie holder is dead, so its lock is reclaimed rather than blocking", { skip: !LINUX }, async () => {
  const dir = await fresh();
  const z = await zombieChild();
  try {
    assert.match(readProcStat(z.pid)?.state ?? "", /^Z/, "precondition: the holder is a zombie, not merely gone");
    await plant(dir, {
      pid: z.pid, host: os.hostname(), startedAt: Date.now(), token: "zombie-holder",
      start: readProcStat(z.pid)?.starttime, groups: [],
    });
    const lock = await acquireProjectLock(dir, OPTS);
    assert.notEqual(JSON.parse(readFileSync(lockFile(dir), "utf8")).token, "zombie-holder");
    lock.release();
  } finally {
    await z.stop();
  }
});
