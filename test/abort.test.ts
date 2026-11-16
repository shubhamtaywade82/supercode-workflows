import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClaudeCodeAdapter,
  type ExecFn,
  type HostAdapter,
  type Registry,
  runProcess,
  StepTimeoutError,
  type TurnResult,
  WorkflowEngine,
  type Workflow,
} from "../src/index.js";

const reg = (wfs: Record<string, Workflow>): Registry => new Map(Object.entries(wfs));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const recordedClaude = JSON.stringify({ is_error: false, result: "late", session_id: "s" });

/** An ExecFn that runs a real shell script under the adapter's signal, standing in for the agent CLI. */
function scriptExec(script: string): ExecFn {
  return async (_bin, _args, opts) => {
    const out = await runProcess("sh", ["-c", script], { signal: opts.signal });
    if (out.aborted) throw new Error("aborted");
    return { stdout: recordedClaude };
  };
}

test("a turn timeout ends the agent's process tree, not just the promise", async () => {
  const flag = path.join(await mkdtemp(path.join(os.tmpdir(), "scwf-abort-")), "touched");
  // The write happens in a grandchild, so only a true group kill keeps it from landing (see test/proc.test.ts).
  const host = new ClaudeCodeAdapter({ exec: scriptExec(`sh -c "sleep 1; touch ${flag}"; true`) });
  const engine = new WorkflowEngine({
    host,
    registry: reg({ W: { steps: [{ name: "turn", prompt: "x", timeoutMs: 150 }] } }),
  });
  await assert.rejects(engine.run("W", { prompt: "p" }), StepTimeoutError);
  await sleep(1_200);
  assert.equal(existsSync(flag), false, "the agent's child must not keep running after the step failed");
});

test("a host that ignores the abort signal still cannot hang the engine", async () => {
  const host: HostAdapter = {
    sendTurn: () => new Promise<TurnResult>(() => undefined), // never settles, and never looks at the signal
    resetContext: () => undefined,
  };
  const engine = new WorkflowEngine({
    host,
    abortConfirmMs: 50,
    registry: reg({ W: { steps: [{ name: "t", prompt: "x", timeoutMs: 100 }] } }),
  });
  const started = Date.now();
  await assert.rejects(engine.run("W", { prompt: "p" }), StepTimeoutError);
  assert.ok(Date.now() - started < 1_000, "the step must fail within the confirmation window");
});

test("the turn's abort signal reaches the adapter's process layer", async () => {
  let received: AbortSignal | undefined;
  const exec: ExecFn = async (_bin, _args, opts) => {
    received = opts.signal;
    return { stdout: recordedClaude };
  };
  const ac = new AbortController();
  await new ClaudeCodeAdapter({ exec }).sendTurn({ prompt: "x" }, { signal: ac.signal });
  assert.equal(received, ac.signal);
});
