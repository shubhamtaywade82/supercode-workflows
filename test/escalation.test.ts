import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processAlive, readProcStat, runProcess } from "../src/index.js";

const LINUX = process.platform === "linux";
const POSIX = process.platform !== "win32";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the value, or "timeout" after `ms`. The timer is cleared either way, so it never keeps the process alive. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function sentinel(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "scwf-esc-")), "touched");
}

test("abort ends a leader that ignores SIGTERM: escalation to SIGKILL, the promise settles, the sentinel never lands", { skip: !POSIX }, async () => {
  const flag = await sentinel();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const started = Date.now();
  // The leader and its background subshell both inherit an ignored SIGTERM, so only SIGKILL ends them. The sleep is longer
  // than the 2 s grace period, so a group that is never escalated would still land the file.
  const outcome = await within(
    runProcess("sh", ["-c", `trap "" TERM; (sleep 4; touch ${flag}) & wait`], { signal: ac.signal }),
    9_000,
  );
  if (outcome === "timeout") assert.fail("a SIGTERM-ignoring leader hung the run");
  assert.equal(outcome.aborted, true);
  assert.ok(Date.now() - started < 4_000, "the run settles after the grace period, not after the sleep");
  await sleep(4_500);
  assert.equal(existsSync(flag), false, "nothing in the killed group may write afterwards");
});

test("a zombie is not a live process, and a live process is", { skip: !LINUX }, async () => {
  // perl forks a child that exits at once, and perl never waits for it, so the child stays a zombie while perl sleeps.
  // sh is not usable here: it reaps its own background jobs, so no zombie would be visible.
  const parent = spawn("perl", ["-e", 'my $p = fork(); if ($p == 0) { exit 0 } $| = 1; print "$p\\n"; sleep 5;'], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const pid = await new Promise<number>((resolve) => {
      parent.stdout.once("data", (d: Buffer) => resolve(Number(String(d).trim())));
    });
    await sleep(300);
    assert.match(readProcStat(pid)?.state ?? "", /^Z/, "precondition: the child is a zombie");
    assert.equal(processAlive(pid), false, "a zombie must not count as a live process");
    const self = readProcStat(process.pid);
    assert.equal(processAlive(process.pid, self?.starttime), true, "control: a live process is alive");
  } finally {
    parent.kill("SIGKILL");
    await new Promise((resolve) => parent.once("exit", resolve));
  }
});
