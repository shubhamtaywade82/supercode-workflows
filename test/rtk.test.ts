import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockHost, RtkAdapter, RtkError, WorkflowEngine } from "../src/index.js";
import type { ConfirmPreview, Registry, RtkErrorKind, Step, Workflow } from "../src/index.js";

// These tests use a stub rtk, a shell script that stands in for the binary. They exercise the real spawn path, exit codes
// and argv. They do not verify upstream's behaviour: that is pinned by the protocol comment in src/rtk.ts.

interface StubSpec {
  /** Exit code of `rtk --version`. */
  version?: number;
  /** Exit code of `rtk rewrite`. */
  rewriteExit: number;
  /** Stdout of `rtk rewrite`, verbatim. */
  rewriteOut: string;
  /** Stderr of `rtk rewrite`, verbatim. */
  rewriteErr?: string;
}

interface Stub { bin: string; log: string; command: string }

/**
 * Logs every call to `log`, and writes the command argument of `rewrite` to `command`, byte for byte. The argument count
 * and the telemetry variable are logged too, so the tests can check both.
 */
function stubRtk(spec: StubSpec): Stub {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rtk-stub-"));
  const log = path.join(dir, "calls.log");
  const command = path.join(dir, "command.txt");
  const out = path.join(dir, "rewrite.out");
  writeFileSync(out, spec.rewriteOut);
  const err = path.join(dir, "rewrite.err");
  writeFileSync(err, spec.rewriteErr ?? "");
  const bin = path.join(dir, "rtk");
  writeFileSync(bin, [
    "#!/bin/sh",
    "case \"$1\" in",
    `  --version) printf 'version telemetry=%s\\n' "$RTK_TELEMETRY_DISABLED" >> '${log}'; echo "rtk stub"; exit ${spec.version ?? 0} ;;`,
    `  rewrite) printf 'rewrite argc=%s telemetry=%s\\n' "$#" "$RTK_TELEMETRY_DISABLED" >> '${log}'; printf '%s' "$2" > '${command}'; cat '${out}'; cat '${err}' >&2; exit ${spec.rewriteExit} ;;`,
    `  *) printf 'unexpected argv=%s\\n' "$*" >> '${log}'; exit 98 ;;`,
    "esac",
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return { bin, log, command };
}

function calls(stub: Stub): string[] {
  return existsSync(stub.log) ? readFileSync(stub.log, "utf8").split("\n").filter(Boolean) : [];
}

function workDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "rtk-work-"));
}

const reg = (wfs: Record<string, Workflow>): Registry => new Map(Object.entries(wfs));

function shellEngine(
  steps: Step[],
  rtk?: RtkAdapter,
  extra: { confirm?: (p: ConfirmPreview) => Promise<boolean> } = {},
): WorkflowEngine {
  return new WorkflowEngine({ host: new MockHost(req => req.prompt), registry: reg({ W: { steps } }), rtk, ...extra });
}

const isRtkError = (kind: RtkErrorKind) => (err: unknown): boolean => err instanceof RtkError && err.kind === kind;

test("the probe runs once, however many rewrites follow", async () => {
  const stub = stubRtk({ rewriteExit: 1, rewriteOut: "" });
  const rtk = new RtkAdapter({ bin: stub.bin });
  await rtk.prepare("echo a");
  await rtk.prepare("echo b");
  assert.equal(calls(stub).filter(l => l.startsWith("version")).length, 1);
  assert.equal(calls(stub).filter(l => l.startsWith("rewrite")).length, 2);
});

test("a missing binary fails closed, and the command does not run", async () => {
  const ran = path.join(workDir(), "ran");
  const e = shellEngine([{ name: "gate", shell: `touch ${ran}`, rtk: true }], new RtkAdapter({ bin: "/nonexistent/rtk-bin" }));
  await assert.rejects(e.run("W", { prompt: "P" }), isRtkError("unavailable"));
  assert.equal(existsSync(ran), false);
});

test("a failing probe is cached: later rewrites fail closed without retrying it", async () => {
  // Exit 0 on rewrite would succeed, so a probe that is skipped or ignored would be caught by the test below.
  const stub = stubRtk({ version: 1, rewriteExit: 0, rewriteOut: "printf REWRITTEN" });
  const rtk = new RtkAdapter({ bin: stub.bin });
  await assert.rejects(rtk.prepare("echo a"), isRtkError("unavailable"));
  await assert.rejects(rtk.prepare("echo b"), isRtkError("unavailable"));
  assert.equal(calls(stub).filter(l => l.startsWith("version")).length, 1);
  assert.equal(calls(stub).filter(l => l.startsWith("rewrite")).length, 0);
});

test("an allowed rewrite runs the rewritten command, not the original", async () => {
  const stub = stubRtk({ rewriteExit: 0, rewriteOut: "printf REWRITTEN" });
  const e = shellEngine([{ name: "s", shell: "printf ORIGINAL", rtk: true }], new RtkAdapter({ bin: stub.bin }));
  const r = await e.run("W", { prompt: "P" });
  assert.equal(r.state.response, "REWRITTEN");
});

test("the exit code of the rewritten command is what the gate reads", async () => {
  const stub = stubRtk({ rewriteExit: 0, rewriteOut: "sh -c 'exit 7'" });
  const e = shellEngine([{ name: "gate", shell: "exit 0", rtk: true }], new RtkAdapter({ bin: stub.bin }));
  await assert.rejects(e.run("W", { prompt: "P" }), /shell step "gate" exited 7/);
});

test("the rewritten command's stderr reaches the error, and never the response", async () => {
  const stub = stubRtk({ rewriteExit: 0, rewriteOut: "printf OUT; printf BOOM >&2; exit 4" });
  const failing = shellEngine([{ name: "s", shell: "exit 0", rtk: true }], new RtkAdapter({ bin: stub.bin }));
  await assert.rejects(failing.run("W", { prompt: "P" }), (err: unknown) => err instanceof Error && err.message.includes("BOOM"));

  const tolerated = shellEngine([{ name: "s", shell: "exit 0", rtk: true, continueOnError: true }], new RtkAdapter({ bin: stub.bin }));
  const r = await tolerated.run("W", { prompt: "P" });
  assert.equal(r.state.response, "OUT");
});

test("exit 1 (no rewrite) runs the original command unchanged", async () => {
  const stub = stubRtk({ rewriteExit: 1, rewriteOut: "" });
  const e = shellEngine([{ name: "s", shell: "printf ORIGINAL", rtk: true }], new RtkAdapter({ bin: stub.bin }));
  const r = await e.run("W", { prompt: "P" });
  assert.equal(r.state.response, "ORIGINAL");
});

test("exit 1 with empty stdout and no marker passes the original through", async () => {
  const stub = stubRtk({ rewriteExit: 1, rewriteOut: "" });
  assert.equal(await new RtkAdapter({ bin: stub.bin }).prepare("echo a"), "echo a");
});

test("exit 1 with rtk's integrity-check marker is refused, and the original does not run", async () => {
  // Upstream's fallback dispatcher exits 1 with this message when its integrity check fails and the tool is never reached.
  const original = path.join(workDir(), "original");
  const stub = stubRtk({ rewriteExit: 1, rewriteOut: "", rewriteErr: "hook integrity check FAILED: tool not reached\n" });
  const e = shellEngine([{ name: "s", shell: `touch ${original}`, rtk: true }], new RtkAdapter({ bin: stub.bin }));
  await assert.rejects(e.run("W", { prompt: "P" }), isRtkError("integrity"));
  assert.equal(existsSync(original), false, "the original command must not run");
});

test("exit 1 with stdout is anomalous under the pinned (1, \"\") contract, and nothing runs", async () => {
  const original = path.join(workDir(), "original");
  const stub = stubRtk({ rewriteExit: 1, rewriteOut: `touch ${original}` });
  const e = shellEngine([{ name: "s", shell: `touch ${original}`, rtk: true }], new RtkAdapter({ bin: stub.bin }));
  await assert.rejects(e.run("W", { prompt: "P" }), isRtkError("unexpected"));
  assert.equal(existsSync(original), false, "the original command must not run");
});

/** A refused command must not run, in either form: the original or what rtk would have rewritten it to. */
async function assertRefused(rewriteExit: number, rewriteOut: (rewritten: string) => string, kind: RtkErrorKind): Promise<void> {
  const dir = workDir();
  const original = path.join(dir, "original");
  const rewritten = path.join(dir, "rewritten");
  const stub = stubRtk({ rewriteExit, rewriteOut: rewriteOut(rewritten) });
  const e = shellEngine([{ name: "s", shell: `touch ${original}`, rtk: true }], new RtkAdapter({ bin: stub.bin }));
  await assert.rejects(e.run("W", { prompt: "P" }), isRtkError(kind));
  assert.equal(existsSync(original), false, "the original command must not run");
  assert.equal(existsSync(rewritten), false, "the rewritten command must not run");
}

test("exit 2 (deny) is refused, and nothing runs", () => assertRefused(2, r => `touch ${r}`, "denied"));
test("exit 3 (ask) is refused headless, and nothing runs", () => assertRefused(3, r => `touch ${r}`, "ask"));
test("an undefined exit code is refused, and nothing runs", () => assertRefused(5, r => `touch ${r}`, "unexpected"));
test("exit 0 with empty output is refused, and nothing runs", () => assertRefused(0, () => "", "rewrite-failed"));

test("RTK_TELEMETRY_DISABLED=1 reaches every rtk call, and the adapter cannot override it", async () => {
  const stub = stubRtk({ rewriteExit: 1, rewriteOut: "" });
  await new RtkAdapter({ bin: stub.bin, env: { RTK_TELEMETRY_DISABLED: "0" } }).prepare("echo a");
  const lines = calls(stub);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /telemetry=1$/);
});

test("rewrite receives the whole command as one argument, byte for byte", async () => {
  const stub = stubRtk({ rewriteExit: 1, rewriteOut: "" });
  const cmd = `printf '%s' "a b" | tr a-z A-Z; echo 'it'"'"'s' && echo $((1+2))`;
  await new RtkAdapter({ bin: stub.bin }).prepare(cmd);
  assert.match(calls(stub).join("\n"), /rewrite argc=2/);
  assert.equal(readFileSync(stub.command, "utf8"), cmd);
});

test("a confirmation preview shows the rewritten command, which is the one that runs", async () => {
  const stub = stubRtk({ rewriteExit: 0, rewriteOut: "printf REWRITTEN" });
  const previewed: string[] = [];
  const e = shellEngine(
    [{ name: "s", shell: "printf ORIGINAL", rtk: true, requireConfirm: true }],
    new RtkAdapter({ bin: stub.bin }),
    { confirm: async (p) => { previewed.push(p.command ?? ""); return true; } },
  );
  const r = await e.run("W", { prompt: "P" });
  assert.deepEqual(previewed, ["printf REWRITTEN"]);
  assert.equal(r.state.response, "REWRITTEN");
});

test("rtk: true with no adapter configured fails closed, and the command does not run", async () => {
  const ran = path.join(workDir(), "ran");
  const e = shellEngine([{ name: "s", shell: `touch ${ran}`, rtk: true }]);
  await assert.rejects(e.run("W", { prompt: "P" }), isRtkError("unavailable"));
  assert.equal(existsSync(ran), false);
});

test("rtk on a non-shell step is a configuration error, and nothing runs", async () => {
  const e = shellEngine([{ name: "p", prompt: "hi", rtk: true }], new RtkAdapter({ bin: "/nonexistent/rtk-bin" }));
  await assert.rejects(e.run("W", { prompt: "P" }), /rtk applies only to shell steps/);
});

test("a shell step without rtk runs unwrapped, and needs no adapter", async () => {
  const e = shellEngine([{ name: "s", shell: "printf PLAIN", rtk: false }]);
  const r = await e.run("W", { prompt: "P" });
  assert.equal(r.state.response, "PLAIN");
});
