import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildServer } from "../src/server.js";
import { claudeOk, makeProject, makeRuntime } from "./helpers.js";

/** Real MCP client and server over the SDK's in-memory transport: exercises the v2 API without a subprocess. */
async function connect() {
  const rt = makeRuntime(await makeProject(), async () => ({ stdout: claudeOk("done") }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(rt);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

test("four tools are advertised, with safety annotations on workflow_run", async () => {
  const { client, server } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["context_boost", "workflow_list", "workflow_preview", "workflow_run"]);
    const run = tools.find((t) => t.name === "workflow_run");
    assert.equal(run?.annotations?.destructiveHint, true);
    assert.equal(run?.annotations?.readOnlyHint, false);
    const list = tools.find((t) => t.name === "workflow_list");
    assert.equal(list?.annotations?.readOnlyHint, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("results round-trip as JSON, and refusals come back as isError", async () => {
  const { client, server } = await connect();
  try {
    const listed = await client.callTool({ name: "workflow_list", arguments: {} });
    const body = JSON.parse((listed.content[0] as { text: string }).text) as { workflows: { name: string }[] };
    assert.ok(body.workflows.some((w) => w.name === "Plan"));

    const denied = await client.callTool({
      name: "workflow_run",
      arguments: { name: "Plan", prompt: "x", allow_side_effects: false },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("schema violations are rejected before the handler runs", async () => {
  const { client, server } = await connect();
  try {
    const outcome = await client
      .callTool({ name: "workflow_preview", arguments: { name: "" } })
      .then((r) => r, (e: unknown) => e);
    assert.ok(outcome instanceof Error || (outcome as { isError?: boolean }).isError === true);
  } finally {
    await client.close();
    await server.close();
  }
});
