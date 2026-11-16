import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/index.js";

// runProcess keeps the last 64 Ki characters of stderr. Anything dropped must be reported, because a caller that scans stderr
// for a marker cannot otherwise tell "absent" from "lost".

test("stderr within the kept window is complete and not flagged", async () => {
  const r = await runProcess("sh", ["-c", "printf small >&2"]);
  assert.equal(r.stderr, "small");
  assert.equal(r.stderrTruncated, false);
});

test("stderr beyond the kept window is flagged, and keeps its tail", async () => {
  const r = await runProcess("sh", ["-c", "printf HEAD >&2; head -c 70000 /dev/zero | tr '\\0' x >&2; printf TAIL >&2"]);
  assert.equal(r.stderrTruncated, true);
  assert.equal(r.stderr.length, 64 * 1024);
  assert.ok(r.stderr.endsWith("TAIL"));
  assert.ok(!r.stderr.includes("HEAD"));
});
