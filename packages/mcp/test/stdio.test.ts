import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { makeProject } from "./helpers.js";

// Compiled layout: dist/test/stdio.test.js -> dist/src/cli.js
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text;

test("end to end over stdio: a real server process runs the two-phase workflow", async () => {
  const dir = await makeProject();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "--host-agent", "echo", "--project-dir", dir],
    // Only the variables the process needs. Nesting variables are deliberately absent.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-e2e", version: "0.0.0" });
  await client.connect(transport);
  try {
    const listed = JSON.parse(textOf(await client.callTool({ name: "workflow_list", arguments: {} }))) as {
      workflows: { name: string }[];
    };
    assert.ok(listed.workflows.some((w) => w.name === "Plan"));

    const preview = JSON.parse(textOf(await client.callTool({
      name: "workflow_preview",
      arguments: { name: "Plan", prompt: "add rate limiting" },
    }))) as { confirm_token?: string };
    assert.equal(typeof preview.confirm_token, "string");

    const run = JSON.parse(textOf(await client.callTool({
      name: "workflow_run",
      arguments: {
        name: "Plan",
        prompt: "add rate limiting",
        allow_side_effects: true,
        confirm_token: preview.confirm_token,
      },
    }))) as { response: string };
    assert.equal(run.response, "echo:Design: add rate limiting");
  } finally {
    await client.close();
  }
});
