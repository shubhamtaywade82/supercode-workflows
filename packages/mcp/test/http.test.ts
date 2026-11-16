import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRequest, startHttp } from "../src/http.js";
import { claudeOk, makeProject, makeRuntime } from "./helpers.js";

const TOKEN = "t".repeat(40);

test("authorizeRequest enforces loopback host, loopback origin, and the bearer token", () => {
  const good = { host: "127.0.0.1:8787", authorization: `Bearer ${TOKEN}` };
  assert.equal(authorizeRequest(good, TOKEN).ok, true);
  assert.equal(authorizeRequest({ ...good, authorization: "Bearer wrong" }, TOKEN).ok, false);
  assert.equal(authorizeRequest({ host: "127.0.0.1:8787" }, TOKEN).ok, false);
  assert.equal(authorizeRequest({ ...good, origin: "https://evil.example" }, TOKEN).ok, false);
  assert.equal(authorizeRequest({ ...good, origin: "http://localhost:3000" }, TOKEN).ok, true);
  assert.equal(authorizeRequest({ ...good, host: "evil.example" }, TOKEN).ok, false); // DNS rebinding
});

test("startHttp serves /mcp only with a valid token", async () => {
  const rt = makeRuntime(await makeProject(), async () => ({ stdout: claudeOk("done") }));
  const running = await startHttp(rt, { token: TOKEN, port: 0 });
  try {
    const noAuth = await fetch(running.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noAuth.status, 401);

    const wrongPath = await fetch(running.url.replace("/mcp", "/other"), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(wrongPath.status, 404);

    const init = await fetch(running.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
      }),
    });
    assert.equal(init.status, 200);
  } finally {
    await running.close();
  }
});

test("startHttp refuses short tokens and non-loopback hosts", async () => {
  const rt = makeRuntime(await makeProject(), async () => ({ stdout: claudeOk("done") }));
  await assert.rejects(startHttp(rt, { token: "short", port: 0 }), /at least 32/);
  await assert.rejects(startHttp(rt, { token: TOKEN, port: 0, host: "0.0.0.0" }), /loopback/);
});
