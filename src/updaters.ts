import { spawn } from "node:child_process";
import vm from "node:vm";
import type { AiClient, Condition, PackedMessage, Updater, WorkflowState } from "./types.js";

export class StepTimeoutError extends Error {}

export function packXml(messages: PackedMessage[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<packed-responses>${messages.map(m =>
    `<message role="${m.role}"${m.name ? ` name="${m.name}"` : ""}>${esc(m.content)}</message>`).join("")}</packed-responses>`;
}

export function interpolate(s: string, state: WorkflowState, env: Record<string, string>): string {
  const vars: Record<string, string> = {
    packedResponses: packXml(state.packed),
    initialSystemPrompt: state.initialSystemPrompt, initialPrompt: state.initialPrompt,
    initialModel: state.initialModel, initialMode: state.initialMode,
    systemPrompt: state.systemPrompt, response: state.response,
    prompt: state.prompt, model: state.model, mode: state.mode,
  };
  return s
    .replace(/\$(packedResponses|initialSystemPrompt|initialPrompt|initialModel|initialMode|systemPrompt|response|prompt|model|mode)(?![A-Za-z0-9_])/g,
      (_, k: string) => vars[k] ?? "")
    .replace(/\$env\.([A-Za-z_][A-Za-z0-9_]*)/g, (_, k: string) => env[k] ?? "");
}

export function execShell(command: string, opts: { env: Record<string, string>; cwd?: string; timeoutMs: number }):
  Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: "/bin/bash", cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += String(d); });
    child.stderr.on("data", d => { stderr += String(d); });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new StepTimeoutError(`shell timed out after ${opts.timeoutMs}ms: ${command}`));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Workflows are trusted code (same trust model as Supercode). vm limits runaway scripts, not malice. */
export function runJs(body: string, state: WorkflowState, env: Record<string, string>, timeoutMs = 1000): unknown {
  const snapshot: unknown = JSON.parse(JSON.stringify({ ...state, packedResponses: packXml(state.packed) }));
  const ctx = vm.createContext({ state: snapshot, env: { ...env } });
  let script: vm.Script;
  try { script = new vm.Script(`(${body}\n)`); }
  catch { script = new vm.Script(`(function(){ ${body}\n})()`); }
  return script.runInContext(ctx, { timeout: timeoutMs });
}

function callUrl(u: { url: string; headers?: Record<string, string> }, state: WorkflowState, timeoutMs: number): Promise<Response> {
  return fetch(u.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...u.headers },
    body: JSON.stringify({
      prompt: state.prompt, systemPrompt: state.systemPrompt, model: state.model,
      mode: state.mode, response: state.response, packedResponses: packXml(state.packed),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function resolveUpdater(u: Updater, state: WorkflowState, env: Record<string, string>,
  ai: AiClient | undefined, timeoutMs: number, cwd?: string): Promise<string> {
  if (typeof u === "string") return interpolate(u, state, env);
  if ("text" in u) return interpolate(u.text, state, env);
  if ("ai" in u) {
    if (!ai) throw new Error("AI updater requires an AiClient (--ai ollama|openai)");
    return (await ai.complete(interpolate(u.ai, state, env))).trim();
  }
  if ("js" in u) { const r = runJs(u.js, state, env); return r == null ? "" : String(r); }
  if ("shell" in u || "command" in u) {
    const cmd = interpolate("shell" in u ? u.shell : u.command, state, env);
    const r = await execShell(cmd, { env, cwd, timeoutMs });
    if (r.code !== 0) throw new Error(`updater shell exited ${r.code}: ${r.stderr.trim()}`);
    return r.stdout.trimEnd();
  }
  if ("url" in u) {
    const res = await callUrl(u, state, timeoutMs);
    if (!res.ok) throw new Error(`updater url HTTP ${res.status}`);
    const text = await res.text();
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const k of ["prompt", "value", "systemPrompt", "text"]) if (typeof j[k] === "string") return j[k] as string;
    } catch { /* plain-text response */ }
    return text;
  }
  throw new Error(`unsupported updater: ${JSON.stringify(u)}`);
}

export async function evalCondition(c: Condition, state: WorkflowState, env: Record<string, string>,
  ai: AiClient | undefined, timeoutMs: number, cwd?: string): Promise<boolean> {
  try {
    if ("js" in c) return Boolean(runJs(c.js, state, env));
    if ("shell" in c || "command" in c) {
      const cmd = interpolate("shell" in c ? c.shell : c.command, state, env);
      return (await execShell(cmd, { env, cwd, timeoutMs })).code === 0;
    }
    if ("url" in c) return (await callUrl(c, state, timeoutMs)).ok;
    if ("ai" in c) {
      if (!ai) throw new Error("AI condition requires an AiClient");
      return /^(true|yes|1)$/i.test((await ai.complete(interpolate(c.ai, state, env))).trim());
    }
  } catch (e) {
    if (e instanceof StepTimeoutError) throw e;
    return false; // failed checks fail closed, never silently pass
  }
  throw new Error(`unsupported condition: ${JSON.stringify(c)}`);
}
