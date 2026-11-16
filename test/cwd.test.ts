import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compiled layout: dist/test/cwd.test.js -> dist/src/cli.js
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function project(workflows: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scwf-cwd-"));
  mkdirSync(path.join(dir, ".supercode", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".supercode", "workflows", "w.yml"), workflows);
  return dir;
}

/** A stand-in CLI on PATH that records its working directory and prints a recorded-shape result. */
function fakeCli(name: string, result: string): { binDir: string; log: string } {
  const binDir = mkdtempSync(path.join(os.tmpdir(), "scwf-bin-"));
  const log = path.join(binDir, "cwd.log");
  const file = path.join(binDir, name);
  writeFileSync(file, `#!/bin/sh\npwd > "$FAKE_LOG"\necho '${result}'\n`);
  chmodSync(file, 0o755);
  return { binDir, log };
}

const CLAUDE_OK = '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1"}';
const CODEX_OK = '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}';

test("the claude host runs its agent in the project directory", () => {
  const proj = project("Write:\n  steps:\n    - prompt: \"make a file\"\n");
  const fake = fakeCli("claude", CLAUDE_OK);
  const r = spawnSync(process.execPath, [CLI, "run", "Write", "--prompt", "x", "--host", "claude", "--permission-mode", "plan", "--dir", proj], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: `${fake.binDir}:${process.env.PATH ?? ""}`, FAKE_LOG: fake.log },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(realpathSync(readFileSync(fake.log, "utf8").trim()), realpathSync(proj));
});

test("the codex host runs its agent in the project directory", () => {
  const proj = project("Write:\n  steps:\n    - prompt: \"make a file\"\n");
  const fake = fakeCli("codex", CODEX_OK);
  const r = spawnSync(process.execPath, [CLI, "run", "Write", "--prompt", "x", "--host", "codex", "--sandbox", "read-only", "--dir", proj], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: `${fake.binDir}:${process.env.PATH ?? ""}`, FAKE_LOG: fake.log },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(realpathSync(readFileSync(fake.log, "utf8").trim()), realpathSync(proj));
});

test("shell steps run in the project directory", () => {
  const proj = project("Where:\n  steps:\n    - name: where\n      shell: pwd\n");
  const r = spawnSync(process.execPath, [CLI, "run", "Where", "--prompt", "x", "--host", "echo", "--dir", proj], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const response = (JSON.parse(r.stdout) as { response: string }).response;
  assert.equal(realpathSync(response), realpathSync(proj));
});
