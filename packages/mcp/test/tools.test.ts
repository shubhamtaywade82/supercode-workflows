import test from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "@nemesis-oss/supercode-workflows";
import { GuardError } from "../src/guard.js";
import { listWorkflows, previewRun, runWorkflow, ToolError } from "../src/tools.js";
import { claudeOk, makeProject, makeRuntime } from "./helpers.js";

const okExec: ExecFn = async () => ({ stdout: claudeOk("done") });
const isCode = (code: string) => (e: unknown): boolean => e instanceof GuardError && e.code === code;

test("list reports side effects per workflow and isolates a broken one", async () => {
  const rt = makeRuntime(await makeProject(), okExec);
  const { workflows } = listWorkflows(rt);
  assert.deepEqual(workflows.map((w) => w.name), ["Bad", "Empty", "Loop", "Plan"]);
  const byName = Object.fromEntries(workflows.map((w) => [w.name, w]));
  assert.equal(byName.Plan.side_effects, true);
  assert.equal(byName.Empty.side_effects, false);
  assert.match(byName.Bad.error ?? "", /cycle detected/);
});

test("preview issues a confirm token only for side-effecting workflows", async () => {
  const rt = makeRuntime(await makeProject(), okExec);
  assert.equal(previewRun(rt, { name: "Empty", prompt: "x" }).confirm_token, undefined);
  const plan = previewRun(rt, { name: "Plan", prompt: "x" });
  assert.equal(plan.requires_confirmation, true);
  assert.equal(typeof plan.confirm_token, "string");
});

test("a run with side effects needs allow_side_effects and a token", async () => {
  const rt = makeRuntime(await makeProject(), okExec);
  await assert.rejects(runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: false }), ToolError);
  await assert.rejects(runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: true }), /confirm_token/);
});

test("the two-phase run executes once, and its token cannot be replayed", async () => {
  const rt = makeRuntime(await makeProject(), okExec);
  const token = previewRun(rt, { name: "Plan", prompt: "x" }).confirm_token ?? "";
  const out = await runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: true, confirm_token: token });
  assert.equal(out.response, "done");
  assert.equal(out.steps_executed, 2); // root container + design
  assert.equal(out.truncated, false);
  await assert.rejects(
    runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: true, confirm_token: token }),
    ToolError,
  );
});

test("a token is bound to the previewed prompt", async () => {
  const rt = makeRuntime(await makeProject(), okExec);
  const token = previewRun(rt, { name: "Plan", prompt: "a" }).confirm_token ?? "";
  await assert.rejects(
    runWorkflow(rt, { name: "Plan", prompt: "b", allow_side_effects: true, confirm_token: token }),
    ToolError,
  );
});

test("workflows without side effects run without a token", async () => {
  const rt = makeRuntime(await makeProject(), okExec);
  const out = await runWorkflow(rt, { name: "Empty", prompt: "x", allow_side_effects: false });
  assert.equal(out.response, "");
  assert.equal(out.steps_executed, 1);
});

test("a second run while one is active is refused as busy", async () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const slow: ExecFn = async () => {
    await gate;
    return { stdout: claudeOk("late") };
  };
  const rt = makeRuntime(await makeProject(), slow);
  const token = previewRun(rt, { name: "Plan", prompt: "x" }).confirm_token ?? "";
  const first = runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: true, confirm_token: token });
  await assert.rejects(runWorkflow(rt, { name: "Empty", prompt: "x", allow_side_effects: false }), isCode("busy"));
  open();
  assert.equal((await first).response, "late");
});

test("responses are capped and the cap is reported", async () => {
  const rt = makeRuntime(await makeProject(), async () => ({ stdout: claudeOk("0123456789") }), { maxResponseChars: 4 });
  const token = previewRun(rt, { name: "Plan", prompt: "x" }).confirm_token ?? "";
  const out = await runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: true, confirm_token: token });
  assert.equal(out.response, "0123");
  assert.equal(out.truncated, true);
  assert.equal(out.response_chars, 10);
});

test("turn-budget exhaustion surfaces as a budget error", async () => {
  const rt = makeRuntime(await makeProject(), okExec, { guard: { maxAgentTurns: 0 } });
  const token = previewRun(rt, { name: "Plan", prompt: "x" }).confirm_token ?? "";
  await assert.rejects(
    runWorkflow(rt, { name: "Plan", prompt: "x", allow_side_effects: true, confirm_token: token }),
    isCode("budget"),
  );
});
