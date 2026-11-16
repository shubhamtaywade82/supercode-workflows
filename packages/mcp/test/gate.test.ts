import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecFn } from "@nemesis-oss/supercode-workflows";
import { GuardError } from "../src/guard.js";
import type { Runtime } from "../src/runtime.js";
import { previewRun, runWorkflow } from "../src/tools.js";
import { claudeOk, makeProject, makeRuntime } from "./helpers.js";

const okExec: ExecFn = async () => ({ stdout: claudeOk("done") });
const isCode = (code: string) => (e: unknown): boolean => e instanceof GuardError && e.code === code;

test("a project held by another process refuses the run as busy, and the token stays unspent", async () => {
  const dir = await makeProject();
  const rt = makeRuntime(dir, okExec);
  const token = previewRun(rt, { name: "Plan", prompt: "x" }).confirm_token ?? "";
  const lock = path.join(dir, ".supercode", "run", "mcp.lock");
  await mkdir(path.dirname(lock), { recursive: true });
  // A live holder on this host. This test process is alive, so the lock is not stale.
  await writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now(), token: "other-server" }));
  await assert.rejects(
    runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: true, confirm_token: token }),
    isCode("busy"),
  );
  await rm(lock);
  const out = await runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: true, confirm_token: token });
  assert.equal(out.response, "done");
});

test("two server instances on one project share a single turn budget", async () => {
  const dir = await makeProject();
  const a = makeRuntime(dir, okExec, { projectTurnBudget: 2 });
  const b = makeRuntime(dir, okExec, { projectTurnBudget: 2 });
  const run = (rt: Runtime) => runWorkflow(rt, {
    name: "Plan",
    prompt: "x",
    allow_side_effects: true,
    confirm_token: previewRun(rt, { name: "Plan", prompt: "x" }).confirm_token ?? "",
  });
  await run(a); // ledger: 1
  await run(b); // ledger: 2
  await assert.rejects(run(a), isCode("budget")); // refused at lock time, before the token is consumed
});
