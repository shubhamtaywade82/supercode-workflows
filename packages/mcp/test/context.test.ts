import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContext } from "../src/context.js";

const base = { maxBytes: 20_000, maxEntries: 100, maxDepth: 4, maxKeyFileBytes: 2_000 };

test("lists source, ignores dependency directories, and never follows symlinks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scwf-ctx-"));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.ts"), "export {};");
  await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await symlink("/etc", path.join(dir, "escape"));
  const r = await buildContext(dir, base);
  assert.match(r.text, /src\//);
  assert.match(r.text, /a\.ts/);
  assert.doesNotMatch(r.text, /node_modules/);
  assert.doesNotMatch(r.text, /escape/);
});

test("key files are excerpted at the per-file byte cap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scwf-ctx-"));
  await writeFile(path.join(dir, "README.md"), "x".repeat(5_000));
  const r = await buildContext(dir, { ...base, maxKeyFileBytes: 100 });
  assert.match(r.text, /## README\.md \(excerpt\)/);
  const excerptLine = r.text.split("\n").find((l) => l.startsWith("xxxx")) ?? "";
  assert.equal(excerptLine.length, 100);
});

test("entry cap and total byte cap both truncate and say so", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scwf-ctx-"));
  for (let i = 0; i < 30; i++) await writeFile(path.join(dir, `f${i}.txt`), "");
  const capped = await buildContext(dir, { ...base, maxEntries: 10 });
  assert.equal(capped.entries, 10);
  assert.equal(capped.truncated, true);

  const small = await buildContext(dir, { ...base, maxBytes: 200 });
  assert.equal(small.truncated, true);
  assert.ok(Buffer.byteLength(small.text) <= 200 + "\n[truncated]".length);
});
