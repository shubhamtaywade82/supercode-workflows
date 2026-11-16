import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeAdapter, type ExecFn } from "../src/index.js";

const ok = JSON.stringify({ is_error: false, result: "ok", session_id: "s" });

test("headless Claude turns deny prompts, and the prompt is the last argument", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args) => {
    calls.push(args);
    return { stdout: ok };
  };
  await new ClaudeCodeAdapter({ exec, permissionMode: "acceptEdits", permissionPrompts: "none" }).sendTurn({ prompt: "hello world" });
  const a = calls[0];
  assert.equal(a[0], "-p");
  assert.equal(a[a.indexOf("--permission-prompts") + 1], "none");
  assert.equal(a[a.length - 1], "hello world");
});

test("without permissionPrompts no prompt-policy flag is sent", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args) => {
    calls.push(args);
    return { stdout: ok };
  };
  await new ClaudeCodeAdapter({ exec }).sendTurn({ prompt: "x" });
  assert.equal(calls[0].includes("--permission-prompts"), false);
});
