import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compiled layout: dist/test/cli.test.js -> dist/src/cli.js
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

test("scwf refuses --host claude without an explicit --permission-mode, before any agent is spawned", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scwf-cli-"));
  await mkdir(path.join(dir, ".supercode", "workflows"), { recursive: true });
  await writeFile(path.join(dir, ".supercode", "workflows", "w.yml"), 'Write:\n  steps:\n    - prompt: "create a file"\n');
  const r = spawnSync(process.execPath, [CLI, "run", "Write", "--prompt", "x", "--host", "claude", "--dir", dir], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Autonomous edits require an explicit --permission-mode \(e\.g\., acceptEdits\)\./);
});
