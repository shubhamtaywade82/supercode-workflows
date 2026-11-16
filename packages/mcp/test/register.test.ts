import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyRegistration, defaultIO, mergeCursorConfig, planRegistration, type RegisterIO } from "../src/register.js";

const noopIO: RegisterIO = {
  run: async () => 0,
  readText: async () => undefined,
  writeText: async () => undefined,
};

test("the claude plan puts options before the name and -- before the command", () => {
  const plan = planRegistration("claude", { hostAgent: "claude", projectDir: "/p" });
  assert.equal(plan.host, "claude");
  assert.deepEqual(plan.command, [
    "claude", "mcp", "add", "--transport", "stdio", "supercode",
    "--", "npx", "-y", "@nemesis-oss/supercode-mcp", "--host-agent", "claude",
  ]);
});

test("the codex snippet uses the mcp_servers table and passes the codex host agent", () => {
  const plan = planRegistration("codex", { hostAgent: "codex", projectDir: "/p" });
  assert.match(plan.printed, /\[mcp_servers\.supercode\]/);
  assert.match(plan.printed, /"--host-agent", "codex"/);
});

test("cursor merge keeps other servers and refuses to overwrite invalid JSON", () => {
  const entry = { command: "npx", args: ["-y", "x"] };
  const merged = JSON.parse(mergeCursorConfig(JSON.stringify({ mcpServers: { other: { command: "o" } } }), entry)) as {
    mcpServers: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["other", "supercode"]);
  assert.throws(() => mergeCursorConfig("{not json", entry), SyntaxError);
  assert.throws(() => mergeCursorConfig("[1,2]", entry), /JSON object/);
});

test("apply runs the exact claude argv through the runner, and a non-zero exit is an error", async () => {
  const plan = planRegistration("claude", { hostAgent: "claude", projectDir: "/p" });
  let seen: string[] = [];
  await applyRegistration(plan, { ...noopIO, run: async (argv) => { seen = argv; return 0; } });
  assert.deepEqual(seen, plan.host === "claude" ? plan.command : []);
  await assert.rejects(applyRegistration(plan, { ...noopIO, run: async () => 1 }), /status 1/);
});

test("codex config is never written automatically", async () => {
  const plan = planRegistration("codex", { hostAgent: "codex", projectDir: "/p" });
  await assert.rejects(applyRegistration(plan, noopIO), /not written automatically/);
});

test("cursor apply writes .cursor/mcp.json in the project and preserves existing servers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scwf-reg-"));
  const plan = planRegistration("cursor", { hostAgent: "claude", projectDir: dir });
  assert.equal(plan.host, "cursor");
  const file = path.join(dir, ".cursor", "mcp.json");
  await applyRegistration(plan, defaultIO); // no existing file: created
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ mcpServers: { keep: { command: "k" } } })); // another server already present
  await applyRegistration(plan, defaultIO); // existing file: merged
  const doc = JSON.parse(await readFile(file, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(doc.mcpServers).sort(), ["keep", "supercode"]);
});
