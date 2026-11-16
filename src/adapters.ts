import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AiClient, HostAdapter, TurnRequest, TurnResult } from "./types.js";

const pExecFile = promisify(execFile);

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

/** Claude Code headless adapter (`claude -p --output-format json`). Requires the claude CLI. */
export class ClaudeCodeAdapter implements HostAdapter {
  private sessionId?: string;
  constructor(private readonly opts: { bin?: string; cwd?: string } = {}) {}
  async sendTurn(req: TurnRequest): Promise<TurnResult> {
    const args = ["-p", req.prompt, "--output-format", "json"];
    if (req.model) args.push("--model", req.model);
    if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
    if (this.sessionId) args.push("--resume", this.sessionId);
    const { stdout: raw } = await pExecFile(this.opts.bin ?? "claude", args, { cwd: this.opts.cwd, maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(String(raw)) as { result?: string; session_id?: string };
    if (parsed.session_id) this.sessionId = parsed.session_id;
    const text = parsed.result ?? "";
    return { text, messages: [{ role: "assistant", content: text }] };
  }
  resetContext(): void { this.sessionId = undefined; }
}

/** Codex headless adapter (`codex exec --json`). Each exec is a fresh session; carry history via $packedResponses. */
export class CodexAdapter implements HostAdapter {
  constructor(private readonly opts: { bin?: string; cwd?: string } = {}) {}
  async sendTurn(req: TurnRequest): Promise<TurnResult> {
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (req.model) args.push("-m", req.model);
    args.push(req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt);
    const { stdout: raw } = await pExecFile(this.opts.bin ?? "codex", args, { cwd: this.opts.cwd, maxBuffer: 64 * 1024 * 1024 });
    let text = "";
    for (const line of String(raw).split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { item?: { type?: string; text?: string }; msg?: { type?: string; message?: string } };
        if (ev.item?.type === "agent_message" && ev.item.text) text = ev.item.text;
        else if (ev.msg?.type === "agent_message" && ev.msg.message) text = ev.msg.message;
      } catch { /* non-JSON line */ }
    }
    return { text, messages: [{ role: "assistant", content: text }] };
  }
  resetContext(): void { /* stateless per exec */ }
}
