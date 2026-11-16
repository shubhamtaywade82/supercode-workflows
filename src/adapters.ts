import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AiClient, HostAdapter, TurnRequest, TurnResult } from "./types.js";

const pExecFile = promisify(execFile);

/** Injectable process executor — lets tests feed recorded fixtures without the real CLIs. */
export type ExecFn = (bin: string, args: string[], opts: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>;
const defaultExec: ExecFn = async (bin, args, opts) => {
  const { stdout } = await pExecFile(bin, args, { cwd: opts.cwd, maxBuffer: opts.maxBuffer });
  return { stdout: String(stdout) };
};

export class MockHost implements HostAdapter {
  readonly turns: TurnRequest[] = [];
  resets = 0;
  constructor(private readonly responder: (req: TurnRequest) => string | Promise<string>) {}
  async sendTurn(req: TurnRequest): Promise<TurnResult> {
    this.turns.push({ ...req });
    const text = await this.responder(req);
    return { text, messages: [{ role: "assistant", content: text }] };
  }
  resetContext(): void { this.resets++; }
}

export class EchoHost extends MockHost {
  constructor() { super(req => `echo:${req.prompt}`); }
}

export class MockAi implements AiClient {
  constructor(private readonly responder: (instruction: string) => string | Promise<string>) {}
  complete(instruction: string): Promise<string> { return Promise.resolve(this.responder(instruction)); }
}

export class OllamaAi implements AiClient {
  constructor(private readonly opts: { baseUrl?: string; model?: string; timeoutMs?: number } = {}) {}
  async complete(instruction: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl ?? "http://127.0.0.1:11434"}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.opts.model ?? "llama3.1", stream: false, messages: [{ role: "user", content: instruction }] }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return (data.message?.content ?? "").trim();
  }
}

export class OpenAiCompatAi implements AiClient {
  constructor(private readonly opts: { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number } = {}) {}
  async complete(instruction: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.opts.model ?? "gpt-4o-mini", messages: [{ role: "user", content: instruction }] }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) throw new Error(`inference HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
}

interface ClaudeResult { result?: string; session_id?: string; is_error?: boolean; subtype?: string }

/** Claude Code headless adapter (`claude -p --output-format json`). Requires the claude CLI. */
export class ClaudeCodeAdapter implements HostAdapter {
  private sessionId?: string;
  /** System prompt the current session was created with. Claude snapshots --append-system-prompt on a session's first request. */
  private sessionSystemPrompt = "";
  private readonly exec: ExecFn;
  constructor(private readonly opts: {
    bin?: string; cwd?: string; exec?: ExecFn;
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  } = {}) { this.exec = opts.exec ?? defaultExec; }

  async sendTurn(req: TurnRequest): Promise<TurnResult> {
    const systemPrompt = req.systemPrompt ?? "";
    // A changed system prompt only applies in a new session, so start one rather than silently resuming the old snapshot.
    if (this.sessionId && systemPrompt !== this.sessionSystemPrompt) this.sessionId = undefined;
    const args = ["-p", req.prompt, "--output-format", "json"];
    if (req.model) args.push("--model", req.model);
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (this.opts.permissionMode) args.push("--permission-mode", this.opts.permissionMode);
    if (this.sessionId) args.push("--resume", this.sessionId);
    const { stdout } = await this.exec(this.opts.bin ?? "claude", args, { cwd: this.opts.cwd, maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as ClaudeResult;
    if (parsed.session_id) { this.sessionId = parsed.session_id; this.sessionSystemPrompt = systemPrompt; }
    if (parsed.is_error) throw new Error(`claude turn error (${parsed.subtype ?? "unknown"}): ${parsed.result ?? ""}`);
    const text = parsed.result ?? "";
    return { text, messages: [{ role: "assistant", content: text }] };
  }
  resetContext(): void { this.sessionId = undefined; }
}

interface CodexEvent { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string } }

/** Codex headless adapter (`codex exec --json`). Each exec is a fresh session; carry history via $packedResponses. */
export class CodexAdapter implements HostAdapter {
  private readonly exec: ExecFn;
  constructor(private readonly opts: {
    bin?: string; cwd?: string; exec?: ExecFn; model?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    /** "never" makes approval-requiring actions fail instead of blocking a headless run. */
    approval?: "on-request" | "never";
  } = {}) { this.exec = opts.exec ?? defaultExec; }

  async sendTurn(req: TurnRequest): Promise<TurnResult> {
    // Default workspace-write so implementation steps can edit files; read-only for review-only workflows.
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", this.opts.sandbox ?? "workspace-write"];
    // Config override (source-attested; not run-verified here): headless runs must not block on approval prompts.
    args.push("-c", `approval_policy="${this.opts.approval ?? "never"}"`);
    const model = req.model ?? this.opts.model;
    if (model) args.push("-m", model);
    args.push(req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt);
    const { stdout } = await this.exec(this.opts.bin ?? "codex", args, { cwd: this.opts.cwd, maxBuffer: 64 * 1024 * 1024 });
    let text = "";
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let ev: CodexEvent;
      try { ev = JSON.parse(line) as CodexEvent; } catch { continue; }
      if (ev.type === "turn.failed") throw new Error(`codex turn failed: ${ev.error?.message ?? "unknown"}`);
      if (ev.type === "error" && !/^Reconnecting/i.test(ev.message ?? "")) throw new Error(`codex stream error: ${ev.message ?? "unknown"}`);
      if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") text = ev.item.text;
    }
    return { text, messages: [{ role: "assistant", content: text }] };
  }
  resetContext(): void { /* stateless per exec */ }
}
