import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WorkflowEngine, MockHost, MockAi, EchoHost, loadWorkflows } from "../src/index.js";
import type { Registry, Workflow } from "../src/index.js";

const reg = (wfs: Record<string, Workflow>): Registry => new Map(Object.entries(wfs));

test("guaranteed sequential execution + $response chaining", async () => {
  const host = new MockHost(req => `R(${req.prompt})`);
  const e = new WorkflowEngine({ host, registry: reg({ W: { steps: [
    { name: "a", prompt: "first: $prompt" },
    { name: "b", prompt: "second: $response" },
  ] } }) });
  const r = await e.run("W", { prompt: "P" });
  assert.equal(host.turns.length, 2);
  assert.equal(host.turns[0].prompt, "first: P");
  assert.equal(host.turns[1].prompt, "second: R(first: P)");
  assert.equal(r.state.response, "R(second: R(first: P))");
});

test("model/mode persist across steps; $initialModel restores reference", async () => {
  const host = new MockHost(req => `ok:${req.model}`);
  const e = new WorkflowEngine({ host, registry: reg({ W: {
    model: "plan-model", mode: "architect",
    steps: [
      { name: "plan", prompt: "plan $prompt" },
      { name: "impl", model: "impl-model", prompt: "impl $model was $initialModel" },
    ],
  } }) });
  await e.run("W", { prompt: "P", model: "base-model", mode: "chat" });
  assert.equal(host.turns[0].model, "plan-model");
  assert.equal(host.turns[0].mode, "architect");
  assert.equal(host.turns[1].model, "impl-model");
  assert.equal(host.turns[1].prompt, "impl impl-model was base-model");
});

test("shell condition gates (exit 0 runs, exit 1 skips subtree)", async () => {
  const host = new MockHost(req => req.prompt);
  const e = new WorkflowEngine({ host, registry: reg({ W: { steps: [
    { name: "gate", when: { shell: "exit 1" }, prompt: "never" },
    { name: "ok", when: { shell: "exit 0" }, prompt: "runs" },
  ] } }) });
  await e.run("W", { prompt: "P" });
  assert.equal(host.turns.length, 1);
  assert.equal(host.turns[0].prompt, "runs");
});

test("js + ai conditions", async () => {
  const ai = new MockAi(i => i.includes("approve") ? "yes" : "no");
  const host = new MockHost(req => req.prompt === "seed" ? "ok" : `done:${req.prompt}`);
  const e = new WorkflowEngine({ host, ai, registry: reg({ W: { steps: [
    { name: "seed", prompt: "seed" },
    { name: "jsok", when: { js: "state.response.includes('ok')" }, prompt: "js-pass" },
    { name: "aiok", when: { ai: "approve? $response" }, prompt: "ai-pass" },
    { name: "aino", when: { ai: "reject? $response" }, prompt: "ai-skip" },
  ] } }) });
  await e.run("W", { prompt: "P" });
  assert.deepEqual(host.turns.map(t => t.prompt), ["seed", "js-pass", "ai-pass"]);
});

test("shell step stdout becomes $response", async () => {
  const host = new MockHost(req => req.prompt);
  const e = new WorkflowEngine({ host, registry: reg({ W: { steps: [
    { name: "sh", shell: "printf hello" },
    { name: "use", prompt: "got $response" },
  ] } }) });
  const r = await e.run("W", { prompt: "P" });
  assert.equal(host.turns[0].prompt, "got hello");
  assert.ok(r.state.packed.some(m => m.role === "tool" && m.content === "hello"));
});

test("ref links + legacy actions array", async () => {
  const host = new MockHost(req => `R(${req.prompt})`);
  const e = new WorkflowEngine({ host, registry: reg({
    A: { steps: [{ prompt: "A" }] },
    B: { actions: ["A"], steps: [{ prompt: "B after $response" }] },
  }) });
  await e.run("B", { prompt: "P" });
  assert.deepEqual(host.turns.map(t => t.prompt), ["A", "B after R(A)"]);
});

test("bounded loop (Ralph Wiggum pattern)", async () => {
  let n = 0;
  const host = new MockHost(() => { n++; return n >= 3 ? "done" : "continue"; });
  const e = new WorkflowEngine({ host, registry: reg({ W: { steps: [
    { name: "loop", loop: { while: { js: "state.response !== 'done'" }, maxIterations: 10 },
      steps: [{ prompt: "iterate" }] },
  ] } }) });
  await e.run("W", { prompt: "P" });
  assert.equal(host.turns.length, 3);
});

test("context isolation: future steps invisible; resetContext clears packing", async () => {
  const host = new MockHost(req => `R(${req.prompt})`);
  const e = new WorkflowEngine({ host, registry: reg({ W: { steps: [
    { name: "s1", prompt: "s1" },
    { name: "s2", resetContext: true, prompt: "s2 $packedResponses" },
  ] } }) });
  await e.run("W", { prompt: "P" });
  assert.equal(host.turns[0].prompt, "s1");
  assert.ok(!host.turns[0].prompt.includes("s2"));
  assert.equal(host.resets, 1);
  assert.equal(host.turns[1].prompt, "s2 <packed-responses></packed-responses>");
});

test("$packedResponses accumulates prior messages", async () => {
  const host = new MockHost(req => `R(${req.prompt})`);
  const e = new WorkflowEngine({ host, registry: reg({ W: { steps: [
    { prompt: "s1" },
    { prompt: "ctx: $packedResponses" },
  ] } }) });
  await e.run("W", { prompt: "P" });
  assert.ok(host.turns[1].prompt.includes('<message role="assistant">R(s1)</message>'));
});

test("budgets: maxSteps, maxDepth, step timeout", async () => {
  const host = new MockHost(req => req.prompt);
  await assert.rejects(
    new WorkflowEngine({ host, maxSteps: 2, registry: reg({ W: { steps: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }] } }) }).run("W", { prompt: "P" }),
    /step budget/);
  await assert.rejects(
    new WorkflowEngine({ host, maxDepth: 2, registry: reg({ W: { ref: "W" } }) }).run("W", { prompt: "P" }),
    /depth budget/);
  await assert.rejects(
    new WorkflowEngine({ host, registry: reg({ W: { steps: [{ shell: "sleep 5", timeoutMs: 150 }] } }) }).run("W", { prompt: "P" }),
    /timed out/);
});

test("loader: YAML+JSON, project overrides global, .env interpolation", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "scwf-proj-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scwf-home-"));
  fs.mkdirSync(path.join(proj, ".supercode", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(home, ".supercode", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".supercode", "workflows", "a.yml"), "W:\n  steps:\n    - prompt: 'hi $env.GREETING'\n");
  fs.writeFileSync(path.join(proj, ".supercode", "workflows", "b.json"), JSON.stringify({ J: { steps: [{ shell: "printf $env.GREETING" }] } }));
  fs.writeFileSync(path.join(home, ".supercode", "workflows", "g.yml"), "W:\n  steps:\n    - prompt: global\n");
  fs.writeFileSync(path.join(proj, ".env"), "GREETING=hello\n");
  const { registry, env } = loadWorkflows({ projectRoot: proj, homeDir: home });
  assert.ok(registry.has("W") && registry.has("J"));
  const r = await new WorkflowEngine({ host: new EchoHost(), registry, env }).run("W", { prompt: "P" });
  assert.equal(r.state.response, "echo:hi hello");
  const r2 = await new WorkflowEngine({ host: new EchoHost(), registry, env }).run("J", { prompt: "P" });
  assert.equal(r2.state.response, "hello");
});

test("requireConfirm: deny by default, run when approved", async () => {
  const host = new MockHost(req => req.prompt);
  const wf = reg({ W: { steps: [{ name: "danger", requireConfirm: true, prompt: "danger" }] } });
  await new WorkflowEngine({ host, registry: wf }).run("W", { prompt: "P" });
  assert.equal(host.turns.length, 0);
  const host2 = new MockHost(req => req.prompt);
  await new WorkflowEngine({ host: host2, registry: wf, confirm: async () => true }).run("W", { prompt: "P" });
  assert.equal(host2.turns.length, 1);
});

test("url updater + url condition", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/u") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ prompt: "from-server" })); }
    else if (req.url === "/ok") res.end("ok");
    else { res.statusCode = 500; res.end("no"); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const host = new MockHost(req => req.prompt);
    const e = new WorkflowEngine({ host, registry: reg({ W: { steps: [
      { name: "fetch", prompt: { url: `http://127.0.0.1:${port}/u` } },
      { name: "gate-ok", when: { url: `http://127.0.0.1:${port}/ok` }, prompt: "passed" },
      { name: "gate-no", when: { url: `http://127.0.0.1:${port}/no` }, prompt: "skipped" },
    ] } }) });
    await e.run("W", { prompt: "P" });
    assert.deepEqual(host.turns.map(t => t.prompt), ["from-server", "passed"]);
  } finally { server.close(); }
});

test("ai updater transforms prompt", async () => {
  // MockAi echoes its instruction: "enhance $prompt" interpolates to "enhance P".
  const ai = new MockAi(i => `enhanced:${i}`);
  const host = new MockHost(req => req.prompt);
  const e = new WorkflowEngine({ host, ai, registry: reg({ W: { steps: [{ prompt: { ai: "enhance $prompt" } }] } }) });
  await e.run("W", { prompt: "P" });
  assert.equal(host.turns[0].prompt, "enhanced:enhance P");
});
