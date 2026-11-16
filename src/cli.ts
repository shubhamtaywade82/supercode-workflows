#!/usr/bin/env node
import { ClaudeCodeAdapter, CodexAdapter, EchoHost, OllamaAi, OpenAiCompatAi, WorkflowEngine, loadWorkflows } from "./index.js";
import type { AiClient, HostAdapter } from "./types.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const cmd = args[0];
const { registry, env } = loadWorkflows({ projectRoot: flag(args, "dir") });

if (cmd === "list") {
  for (const [name, wf] of registry) {
    const menu = wf.menu ? `  [menu: ${Array.isArray(wf.menu) ? wf.menu.join(",") : wf.menu}]` : "";
    console.log(`${name}${menu}`);
  }
} else if (cmd === "run") {
  const name = args[1];
  const prompt = flag(args, "prompt");
  if (!name || prompt === undefined) {
    console.error("usage: scwf run <name> --prompt <text> [--host echo|claude|codex] [--ai ollama|openai] [--model m] [--mode m] [--dir path] [--json-events]");
    process.exit(1);
  }
  const hostKind = flag(args, "host") ?? "echo";
  const host: HostAdapter = hostKind === "claude" ? new ClaudeCodeAdapter() : hostKind === "codex" ? new CodexAdapter() : new EchoHost();
  const aiKind = flag(args, "ai");
  const ai: AiClient | undefined =
    aiKind === "ollama" ? new OllamaAi({ model: flag(args, "ollama-model") }) :
    aiKind === "openai" ? new OpenAiCompatAi({ baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, model: flag(args, "ai-model") }) :
    undefined;
  const jsonEvents = args.includes("--json-events");
  const engine = new WorkflowEngine({
    host, registry, ai, env,
    onEvent: e => {
      if (jsonEvents) console.error(JSON.stringify(e));
      else console.error(`[${e.type}] ${e.workflow ?? ""} ${e.step ?? ""} ${e.reason ?? ""}`.trimEnd());
    },
  });
  const result = await engine.run(name, { prompt, model: flag(args, "model"), mode: flag(args, "mode") });
  console.log(JSON.stringify({
    response: result.state.response, model: result.state.model, mode: result.state.mode,
    stepsExecuted: result.stepsExecuted, durationMs: result.durationMs,
  }, null, 2));
} else {
  console.error("usage: scwf <list|run> ...");
  process.exit(1);
}
