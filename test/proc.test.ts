import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type GroupEvent, execShell, onGroupEvent, runProcess, StepTimeoutError } from "../src/index.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A command whose write happens in a grandchild: the outer shell is the group leader, and the inner shell is a separate
 * process that a leader-only kill would leave running. (A plain `sleep; touch` is written by the leader itself, so a
 * leader-only kill would look correct.) Checked: leader-only kill lets the file appear; a group kill does not.
 */
const nestedWrite = (flag: string): string => `sh -c "sleep 1; touch ${flag}"; true`;

/** A path inside a fresh temp dir. The grandchild writes it only if it survives; the tests assert it never appears. */
async function sentinel(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "scwf-proc-")), "touched");
}

test("abort ends the whole process tree, and the promise settles only after it is gone", async () => {
  const flag = await sentinel();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const started = Date.now();
  const out = await runProcess("sh", ["-c", nestedWrite(flag)], { signal: ac.signal });
  assert.equal(out.aborted, true);
  assert.ok(Date.now() - started < 900, "abort must not wait for the sleep to finish");
  assert.equal(existsSync(flag), false, "the grandchild must not run after the abort");
  await sleep(1_200);
  assert.equal(existsSync(flag), false, "nothing from the killed tree may appear later");
});

test("a timeout in a shell step ends the group and fails the step", async () => {
  const flag = await sentinel();
  await assert.rejects(execShell(nestedWrite(flag), { env: {}, timeoutMs: 150 }), StepTimeoutError);
  await sleep(1_200);
  assert.equal(existsSync(flag), false);
});

test("a background job left behind by a finished process is terminated", async () => {
  const flag = await sentinel();
  const out = await runProcess("sh", ["-c", `(sleep 1; touch ${flag}) & echo done`]);
  assert.equal(out.code, 0);
  assert.equal(out.stdout.trim(), "done");
  await sleep(1_200);
  assert.equal(existsSync(flag), false, "a stray job must not outlive the run");
});

test("normal completion returns output and the exit code", async () => {
  const out = await runProcess("sh", ["-c", "printf hi; exit 3"]);
  assert.equal(out.code, 3);
  assert.equal(out.stdout, "hi");
  assert.equal(out.aborted, false);
  assert.equal(out.timedOut, false);
});

test("output past maxBuffer stops the run and reports overflow", async () => {
  const out = await runProcess("sh", ["-c", "yes | head -c 200000"], { maxBuffer: 10_000 });
  assert.equal(out.overflow, true);
});

test("group events report a start (with the leader's start time on Linux) and an end once the group is empty", async () => {
  const events: GroupEvent[] = [];
  const off = onGroupEvent((e) => events.push(e));
  try {
    await runProcess("sh", ["-c", "true"]);
  } finally {
    off();
  }
  assert.equal(events[0].type, "start");
  assert.equal(events[events.length - 1].type, "end");
  const start = events[0];
  if (start.type === "start" && process.platform === "linux") assert.equal(typeof start.leaderStart, "number");
  assert.equal(events[events.length - 1].type === "end" && events[events.length - 1].pgid, start.type === "start" && start.pgid);
});
