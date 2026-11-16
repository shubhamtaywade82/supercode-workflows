import test from "node:test";
import assert from "node:assert/strict";
import type { Registry, Workflow } from "@nemesis-oss/supercode-workflows";
import { previewWorkflow } from "../src/preview.js";

const reg = (wfs: Record<string, Workflow>): Registry => new Map(Object.entries(wfs));

test("flattens nested steps and counts every side-effecting construct", () => {
  const p = previewWorkflow("W", "P", reg({ W: { steps: [
    { name: "design", prompt: "plan $prompt" },
    { name: "gate", shell: "npm test", requireConfirm: true },
    { name: "ask", when: { ai: "ok?" }, prompt: { ai: "x" } },
  ] } }));
  assert.equal(p.steps.length, 4); // root container + three children
  assert.equal(p.counts.agentTurns, 2);   // design, and ask (it has a prompt)
  assert.equal(p.counts.shellCommands, 1);
  assert.equal(p.counts.aiCalls, 2);      // the condition and the prompt updater
  assert.equal(p.counts.confirmSteps, 1);
  assert.equal(p.sideEffects, true);
});

test("a workflow with no steps has no side effects", () => {
  const p = previewWorkflow("W", "P", reg({ W: { steps: [] } }));
  assert.equal(p.sideEffects, false);
  assert.equal(p.counts.agentTurns, 0);
});

test("linked workflows expand, and cycles are reported", () => {
  const ok = previewWorkflow("A", "P", reg({
    A: { steps: [{ ref: "B" }] },
    B: { steps: [{ prompt: "b" }] },
  }));
  assert.equal(ok.counts.agentTurns, 1);
  assert.throws(() => previewWorkflow("C", "P", reg({
    C: { steps: [{ ref: "D" }] },
    D: { steps: [{ ref: "C" }] },
  })), /cycle detected/);
});

test("disabled steps are skipped", () => {
  const p = previewWorkflow("W", "P", reg({ W: { steps: [{ enabled: false, prompt: "x" }] } }));
  assert.equal(p.counts.agentTurns, 0);
});

test("URL updaters are counted and their headers are never shown", () => {
  const p = previewWorkflow("W", "P", reg({ W: { steps: [{
    name: "post",
    prompt: { url: "https://hooks.example.test/x", headers: { authorization: "Bearer secret-value" } },
  }] } }));
  assert.equal(p.counts.urlCalls, 1);
  assert.equal(p.counts.agentTurns, 1);
  assert.equal(JSON.stringify(p).includes("secret-value"), false);
});

test("summaries cap at 500 steps while the counts keep going", () => {
  const children = Array.from({ length: 600 }, (_, i) => ({ prompt: `p${i}` }));
  const p = previewWorkflow("W", "P", reg({ W: { steps: children } }));
  assert.equal(p.steps.length, 500);
  assert.equal(p.truncated, true);
  assert.equal(p.counts.agentTurns, 600);
});
