#!/usr/bin/env node
import { ClaudeCodeAdapter, CodexAdapter, EchoHost, OllamaAi, OpenAiCompatAi, RtkAdapter, WorkflowEngine, loadWorkflows } from "./index.js";
import { resolve } from "node:path";
import type { AiClient, HostAdapter } from "./types.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`scwf: ${message}`);
  process.exit(1);
}

/** Absent flag -> undefined. Present but not in `allowed` -> exit. A typo must never silently fall back to a wider default. */
function enumFlag<T extends string>(args: string[], name: string, allowed: readonly T[]): T | undefined {
  if (!args.includes(`--${name}`)) return undefined;
  const value = flag(args, name);
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    return fail(`--${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

const args = process.argv.slice(2);
const cmd = args[0];
// The project root is where workflows are read from, and the working directory for every agent turn and shell step.
const projectDir = resolve(flag(args, "dir") ?? process.cwd());
const { registry, env } = loadWorkflows({ projectRoot: projectDir });

if (cmd === "list") {
  for (const [name, wf] of registry) {
    const menu = wf.menu ? `  [menu: ${Array.isArray(wf.menu) ? wf.menu.join(",") : wf.menu}]` : "";
    console.log(`${name}${menu}`);
  }
} else if (cmd === "run") {
  const name = args[1];
  const prompt = flag(args, "prompt");
  if (!name || prompt === undefined) {
    console.error("usage: scwf run <name> --prompt <text> [--host echo|claude|codex] [--sandbox read-only|workspace-write|danger-full-access] [--permission-mode default|acceptEdits|bypassPermissions|plan] [--ai ollama|openai] [--model m] [--mode m] [--dir path] [--rtk-bin path] [--json-events]");
    process.exit(1);
  }
  const hostKind = flag(args, "host") ?? "echo";
  const sandbox = enumFlag(args, "sandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
  const permissionMode = enumFlag(args, "permission-mode", ["default", "acceptEdits", "bypassPermissions", "plan"] as const);
  if (sandbox && hostKind !== "codex") fail("--sandbox applies only to --host codex");
  if (permissionMode && hostKind !== "claude") fail("--permission-mode applies only to --host claude");
  // Only steps that set rtk: true use this binary. Without the flag it is looked up on PATH, and a missing rtk fails those steps closed.
  const rtkBin = flag(args, "rtk-bin");
  if (args.includes("--rtk-bin") && (rtkBin === undefined || rtkBin.startsWith("--"))) fail("--rtk-bin needs the path to an rtk binary");
  // Claude runs here are autonomous. Refuse before anything is spawned, rather than let a prompt stall or a default decide.
  if (hostKind === "claude" && permissionMode === undefined) {
    fail("Autonomous edits require an explicit --permission-mode (e.g., acceptEdits).");
  }
  const host: HostAdapter =
    hostKind === "claude" ? new ClaudeCodeAdapter({ cwd: projectDir, permissionMode, permissionPrompts: "none" }) :
    hostKind === "codex" ? new CodexAdapter({ cwd: projectDir, sandbox }) :
    new EchoHost();
  const aiKind = flag(args, "ai");
  const ai: AiClient | undefined =
    aiKind === "ollama" ? new OllamaAi({ model: flag(args, "ollama-model") }) :
    aiKind === "openai" ? new OpenAiCompatAi({ baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: flag(args, "ai-model") }) :
    undefined;
  const jsonEvents = args.includes("--json-events");
  const engine = new WorkflowEngine({
    host, registry, ai, env, cwd: projectDir,
    rtk: new RtkAdapter({ bin: rtkBin ?? "rtk" }),
    onEvent: e => {
      if (jsonEvents) console.error(JSON.stringify(e));
      else console.error(`[${e.type}] ${e.workflow ?? ""} ${e.step ?? ""} ${e.reason ?? ""}`.trimEnd());
    },
  });
  // Engine errors (a failed gate, an rtk refusal, a budget) are reported as one line with exit 1, not as a stack trace.
  const result = await engine.run(name, { prompt, model: flag(args, "model"), mode: flag(args, "mode") })
    .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
  console.log(JSON.stringify({
    response: result.state.response, model: result.state.model, mode: result.state.mode,
    stepsExecuted: result.stepsExecuted, durationMs: result.durationMs,
  }, null, 2));
} else {
  console.error("usage: scwf <list|run> ...");
  process.exit(1);
}
