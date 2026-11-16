import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { EchoHost, type ExecFn } from "@nemesis-oss/supercode-workflows";
import { RunGuard, GuardError } from "../src/guard.js";
import { CountingHost, createLeafHost } from "../src/host.js";
import { claudeOk } from "./helpers.js";

test("the leaf host passes depth + 1 and the remaining budget to the child environment", async () => {
  const seen: Record<string, string>[] = [];
  const exec: ExecFn = async (_bin, _args, opts) => {
    seen.push(opts.env ?? {});
    return { stdout: claudeOk("ok") };
  };
  const guard = new RunGuard({ maxAgentTurns: 5, depth: 0 });
  const host = createLeafHost({ kind: "claude", cwd: os.tmpdir(), depth: 0, exec }, guard);
  await host.sendTurn({ prompt: "x" });
  assert.equal(seen[0].SCWF_MCP_DEPTH, "1");
  assert.equal(seen[0].SCWF_MCP_TURN_BUDGET, "5");
});

test("the counting host charges every turn and stops at the budget", async () => {
  const guard = new RunGuard({ maxAgentTurns: 1 });
  const host = new CountingHost(new EchoHost(), guard);
  await host.sendTurn({ prompt: "a" });
  await assert.rejects(host.sendTurn({ prompt: "b" }), (e: unknown) => e instanceof GuardError && e.code === "budget");
});
