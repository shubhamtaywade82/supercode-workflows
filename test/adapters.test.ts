import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeAdapter, CodexAdapter } from "../src/index.js";

const codexFixture = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"thinking"}}',
  '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"intermediate"}}',
  '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"final answer"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
].join("\n");

test("CodexAdapter takes the last agent_message, ignores reasoning, passes flags", async () => {
  const calls: string[][] = [];
  const adapter = new CodexAdapter({ exec: async (_bin, args) => { calls.push(args); return { stdout: codexFixture }; } });
  const r = await adapter.sendTurn({ prompt: "do it", model: "gpt-5-codex" });
  assert.equal(r.text, "final answer");
  assert.ok(calls[0].includes("--json") && calls[0].includes("--skip-git-repo-check"));
  assert.ok(calls[0].includes("--sandbox") && calls[0].includes("workspace-write"));
  assert.ok(calls[0].includes("-m") && calls[0].includes("gpt-5-codex"));
  assert.ok(calls[0].includes("-c") && calls[0].includes('approval_policy="never"'));
});

test("CodexAdapter approval option overrides the never default", async () => {
  const calls: string[][] = [];
  const adapter = new CodexAdapter({ approval: "on-request", exec: async (_bin, args) => { calls.push(args); return { stdout: codexFixture }; } });
  await adapter.sendTurn({ prompt: "x" });
  assert.ok(calls[0].includes('approval_policy="on-request"'));
  assert.ok(!calls[0].includes('approval_policy="never"'));
});

test("CodexAdapter throws on turn.failed", async () => {
  const adapter = new CodexAdapter({ exec: async () => ({ stdout: '{"type":"turn.failed","error":{"message":"boom"}}' }) });
  await assert.rejects(adapter.sendTurn({ prompt: "x" }), /turn failed: boom/);
});

test("CodexAdapter tolerates transient Reconnecting notices", async () => {
  const stdout = '{"type":"error","message":"Reconnecting... 1/5"}\n{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}';
  const adapter = new CodexAdapter({ exec: async () => ({ stdout }) });
  assert.equal((await adapter.sendTurn({ prompt: "x" })).text, "ok");
});

const claudeFixture = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "claude final", session_id: "sess-123", usage: {} });

test("ClaudeCodeAdapter parses result, resumes by session_id, resets cleanly", async () => {
  const calls: string[][] = [];
  const adapter = new ClaudeCodeAdapter({ exec: async (_bin, args) => { calls.push(args); return { stdout: claudeFixture }; } });
  assert.equal((await adapter.sendTurn({ prompt: "first", systemPrompt: "sys", model: "sonnet" })).text, "claude final");
  assert.ok(calls[0].includes("--append-system-prompt") && calls[0].includes("--model"));
  await adapter.sendTurn({ prompt: "second", systemPrompt: "sys" });
  assert.ok(calls[1].includes("--resume") && calls[1].includes("sess-123"));
  adapter.resetContext();
  await adapter.sendTurn({ prompt: "third" });
  assert.ok(!calls[2].includes("--resume"));
});

test("ClaudeCodeAdapter starts a new session when the system prompt changes", async () => {
  const calls: string[][] = [];
  let n = 0;
  const adapter = new ClaudeCodeAdapter({ exec: async (_bin, args) => {
    calls.push(args); n++;
    return { stdout: JSON.stringify({ is_error: false, result: `r${n}`, session_id: `s${n}` }) };
  } });
  await adapter.sendTurn({ prompt: "a", systemPrompt: "A" });   // session s1
  await adapter.sendTurn({ prompt: "b", systemPrompt: "A" });   // same prompt: resume s1
  await adapter.sendTurn({ prompt: "c", systemPrompt: "B" });   // changed prompt: fresh session
  assert.ok(calls[1].includes("--resume") && calls[1].includes("s1"));
  assert.ok(!calls[2].includes("--resume"));
  assert.ok(calls[2].includes("--append-system-prompt") && calls[2].includes("B"));
});

test("ClaudeCodeAdapter throws on is_error", async () => {
  const adapter = new ClaudeCodeAdapter({ exec: async () => ({ stdout: JSON.stringify({ is_error: true, subtype: "error_during_execution", result: "failed" }) }) });
  await assert.rejects(adapter.sendTurn({ prompt: "x" }), /claude turn error/);
});
