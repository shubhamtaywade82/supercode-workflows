import type { AiClient, HostAdapter, TurnOptions, TurnRequest, TurnResult } from "./types.js";
import { runProcess } from "./proc.js";

/**
 * Injectable process executor: tests feed recorded fixtures without the real CLIs. An abort on `signal` must end the
 * whole process tree before the promise settles.
 */
export type ExecFn = (bin: string, args: string[], opts: {
  cwd?: string; maxBuffer?: number; env?: Record<string, string>; signal?: AbortSignal;
}) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (bin, args, opts) => {
  // Merged over the parent environment: callers add variables, they never replace it.
  const out = await runProcess(bin, args, { cwd: opts.cwd, env: opts.env, maxBuffer: opts.maxBuffer, signal: opts.signal });
  if (out.aborted) throw new Error(`${bin} was aborted before it completed`);
  if (out.overflow) throw new Error(`${bin} output exceeded maxBuffer`);
  if (out.code !== 0) throw new Error(`${bin} exited with ${out.code}: ${out.stderr.slice(-4000)}`);
  return { stdout: out.stdout };
};

export class MockHost implements HostAdapter {
  readonly turns: TurnRequest[] = [];
  resets = 0;
  constructor(private readonly responder: (req: TurnRequest) => string | Promise<string>) {}
  async sendTurn(req: TurnRequest, _opts?: TurnOptions): Promise<TurnResult> {
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
    env?: Record<string, string>;
    /** Extra CLI arguments appended to every turn (e.g. isolation flags once verified against your CLI version). */
    extraArgs?: string[];
    /**
     * "none": a permission prompt is denied instead of waiting for a human who is not there. Needs Claude Code 2.1.259 or
     * later; older CLIs reject the flag. Only the runner knows whether it is headless, so this is opt-in here.
     */
    permissionPrompts?: "host" | "none";
  } = {}) { this.exec = opts.exec ?? defaultExec; }

  async sendTurn(req: TurnRequest, turnOpts: TurnOptions = {}): Promise<TurnResult> {
    const systemPrompt = req.systemPrompt ?? "";
    // A changed system prompt only applies in a new session, so start one rather than silently resuming the old snapshot.
    if (this.sessionId && systemPrompt !== this.sessionSystemPrompt) this.sessionId = undefined;
    // The prompt goes last, after every option, so no option can be read as part of the prompt.
    const args = ["-p", "--output-format", "json"];
    if (req.model) args.push("--model", req.model);
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (this.opts.permissionMode) args.push("--permission-mode", this.opts.permissionMode);
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (this.opts.permissionPrompts) args.push("--permission-prompts", this.opts.permissionPrompts);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);
    args.push(req.prompt);
    const { stdout } = await this.exec(this.opts.bin ?? "claude", args, {
      cwd: this.opts.cwd, maxBuffer: 64 * 1024 * 1024, env: this.opts.env, signal: turnOpts.signal,
    });
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
    env?: Record<string, string>;
    /** Extra CLI arguments inserted before the prompt (e.g. isolation flags once verified against your CLI version). */
    extraArgs?: string[];
  } = {}) { this.exec = opts.exec ?? defaultExec; }

  async sendTurn(req: TurnRequest, turnOpts: TurnOptions = {}): Promise<TurnResult> {
    // Default workspace-write so implementation steps can edit files; read-only for review-only workflows.
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", this.opts.sandbox ?? "workspace-write"];
    // Config override (source-attested; not run-verified here): headless runs must not block on approval prompts.
    args.push("-c", `approval_policy="${this.opts.approval ?? "never"}"`);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);
    const model = req.model ?? this.opts.model;
    if (model) args.push("-m", model);
    args.push(req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt);
    const { stdout } = await this.exec(this.opts.bin ?? "codex", args, {
      cwd: this.opts.cwd, maxBuffer: 64 * 1024 * 1024, env: this.opts.env, signal: turnOpts.signal,
    });
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
