import { evalCondition, execShell, interpolate, resolveUpdater, StepTimeoutError } from "./updaters.js";
import { RtkError, type RtkAdapter } from "./rtk.js";
import type { AiClient, ConfirmPreview, EngineEvent, HostAdapter, Registry, RunResult, Step, TurnRequest, TurnResult, WorkflowState } from "./types.js";

export interface EngineOptions {
  host: HostAdapter;
  registry: Registry;
  ai?: AiClient;
  env?: Record<string, string>;
  cwd?: string;
  confirm?: (p: ConfirmPreview) => Promise<boolean>;
  maxSteps?: number;        // default 200
  maxDepth?: number;        // default 8 (nesting / recursion)
  maxDurationMs?: number;   // default 30 min
  stepTimeoutMs?: number;   // default 5 min
  abortConfirmMs?: number;  // after a turn times out, how long the host gets to confirm it stopped; default 10 s
  onEvent?: (e: EngineEvent) => void;
  /** Required only by steps that set rtk: true. Without it, such a step fails closed before anything runs. */
  rtk?: RtkAdapter;
}

interface RunCtx { name: string; state: WorkflowState; steps: number; started: number; deadline: number; maxSteps: number }

const EXPIRED: unique symbol = Symbol("expired");

export class WorkflowEngine {
  private readonly o: EngineOptions & Required<Pick<EngineOptions, "maxSteps" | "maxDepth" | "maxDurationMs" | "stepTimeoutMs" | "abortConfirmMs">>;

  constructor(opts: EngineOptions) {
    // Explicit `?? default` per field: a caller passing `maxSteps: undefined` must not disable the budget.
    this.o = {
      ...opts,
      maxSteps: opts.maxSteps ?? 200,
      maxDepth: opts.maxDepth ?? 8,
      maxDurationMs: opts.maxDurationMs ?? 30 * 60_000,
      stepTimeoutMs: opts.stepTimeoutMs ?? 5 * 60_000,
      abortConfirmMs: opts.abortConfirmMs ?? 10_000,
    };
  }

  async run(name: string, input: { prompt: string; systemPrompt?: string; model?: string; mode?: string }): Promise<RunResult> {
    const wf = this.o.registry.get(name);
    if (!wf) throw new Error(`workflow not found: ${name}`);
    const state: WorkflowState = {
      prompt: input.prompt, systemPrompt: input.systemPrompt ?? "", model: input.model ?? "", mode: input.mode ?? "",
      response: "", packed: [],
      initialPrompt: input.prompt, initialSystemPrompt: input.systemPrompt ?? "",
      initialModel: input.model ?? "", initialMode: input.mode ?? "",
    };
    const ctx: RunCtx = {
      name, state, steps: 0, started: Date.now(),
      deadline: Date.now() + (wf.maxDurationMs ?? this.o.maxDurationMs),
      maxSteps: wf.maxSteps ?? this.o.maxSteps,
    };
    this.emit({ type: "workflow:start", workflow: name });
    await this.execStep(wf, ctx, 0, true);
    this.emit({ type: "workflow:end", workflow: name, detail: { steps: ctx.steps } });
    return { state, stepsExecuted: ctx.steps, durationMs: Date.now() - ctx.started };
  }

  /**
   * One agent turn under a deadline. On expiry the host is told to stop through the abort signal, then gets a bounded
   * window to confirm its agent process tree is gone. Only after that does the step fail. A host that ignores the signal
   * cannot hang the engine: the window expires and the step fails anyway.
   */
  private async runTurn(req: TurnRequest, label: string, ms: number): Promise<TurnResult> {
    const ac = new AbortController();
    const pending = this.o.host.sendTurn(req, { signal: ac.signal });
    pending.catch(() => undefined); // a late rejection after expiry must not surface as unhandled
    let expiry: NodeJS.Timeout | undefined;
    const expired = new Promise<typeof EXPIRED>((resolve) => {
      expiry = setTimeout(() => { ac.abort(); resolve(EXPIRED); }, ms);
    });
    try {
      const first = await Promise.race([pending, expired]);
      if (first !== EXPIRED) return first;
    } finally {
      clearTimeout(expiry);
    }
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      pending.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { grace = setTimeout(resolve, this.o.abortConfirmMs); }),
    ]);
    clearTimeout(grace);
    throw new StepTimeoutError(`agent turn "${label}" timed out after ${ms}ms`);
  }

  /**
   * The command a shell step runs. An rtk step is rewritten here, before confirmation. No adapter means the step fails
   * closed: it never runs unwrapped by accident.
   */
  private async shellCommand(raw: string, step: Step, label: string): Promise<string> {
    if (!step.rtk) return raw;
    if (!this.o.rtk) throw new RtkError("unavailable", `step "${label}" sets rtk: true, but no RTK adapter is configured`);
    return this.o.rtk.prepare(raw);
  }

  private emit(e: EngineEvent): void { this.o.onEvent?.(e); }
  private env(): Record<string, string> { return this.o.env ?? {}; }

  private async execWorkflow(name: string, ctx: RunCtx, depth: number): Promise<void> {
    const wf = this.o.registry.get(name);
    if (!wf) throw new Error(`workflow not found: ${name}`);
    this.emit({ type: "workflow:start", workflow: name });
    await this.execStep(wf, ctx, depth, true);
    this.emit({ type: "workflow:end", workflow: name });
  }

  private async execStep(step: Step, ctx: RunCtx, depth: number, isRoot = false): Promise<void> {
    const label = step.name ?? (isRoot ? `${ctx.name} (root)` : `step#${ctx.steps + 1}`);
    if (step.enabled === false) { this.emit({ type: "step:skip", workflow: ctx.name, step: label, reason: "disabled" }); return; }
    if (depth > this.o.maxDepth) throw new Error(`workflow depth budget exceeded (> ${this.o.maxDepth}) at ${label}`);
    if (Date.now() > ctx.deadline) throw new Error(`workflow duration budget exceeded at ${label}`);
    const t = step.timeoutMs ?? this.o.stepTimeoutMs;
    if (step.when && !(await evalCondition(step.when, ctx.state, this.env(), this.o.ai, t, this.o.cwd))) {
      this.emit({ type: "step:skip", workflow: ctx.name, step: label, reason: "condition-false" }); return;
    }
    if (++ctx.steps > ctx.maxSteps) throw new Error(`workflow step budget exceeded (> ${ctx.maxSteps}) at ${label}`);
    this.emit({ type: "step:start", workflow: ctx.name, step: label });
    const s = ctx.state;

    if (step.resetContext) { await this.o.host.resetContext(); s.packed = []; }
    if (step.model !== undefined) s.model = interpolate(step.model, s, this.env());
    if (step.mode !== undefined) s.mode = interpolate(step.mode, s, this.env());
    if (step.systemPrompt !== undefined) s.systemPrompt = await resolveUpdater(step.systemPrompt, s, this.env(), this.o.ai, t, this.o.cwd);
    if (step.prompt !== undefined) s.prompt = await resolveUpdater(step.prompt, s, this.env(), this.o.ai, t, this.o.cwd);

    const wantsShell = step.shell !== undefined;
    const wantsTurn = !wantsShell && step.ref === undefined
      && (step.run ?? step.instantRun ?? !isRoot)
      && (step.prompt !== undefined || step.run === true || step.instantRun === true);
    if (step.rtk && !wantsShell) throw new Error(`step "${label}": rtk applies only to shell steps`);
    // Fixed before confirmation, so the preview shows the command that will actually run, including any rtk rewrite.
    const command = wantsShell ? await this.shellCommand(interpolate(step.shell as string, s, this.env()), step, label) : undefined;

    if ((wantsTurn || wantsShell) && step.requireConfirm) {
      const preview: ConfirmPreview = {
        workflow: ctx.name, step: label, kind: wantsShell ? "shell" : "agent-turn",
        prompt: wantsTurn ? s.prompt : undefined,
        command,
        model: s.model, mode: s.mode,
      };
      const ok = this.o.confirm ? await this.o.confirm(preview) : false; // headless default: deny
      if (!ok) { this.emit({ type: "step:skip", workflow: ctx.name, step: label, reason: "confirm-denied" }); return; }
    }

    if (command !== undefined) {
      const r = await execShell(command, { env: this.env(), cwd: this.o.cwd, timeoutMs: t });
      s.response = r.stdout.trimEnd();
      s.packed.push({ role: "tool", name: "shell", content: s.response });
      if (r.code !== 0 && !step.continueOnError) throw new Error(`shell step "${label}" exited ${r.code}: ${r.stderr.trim()}`);
    } else if (wantsTurn) {
      this.emit({ type: "turn:start", workflow: ctx.name, step: label, detail: { model: s.model, mode: s.mode } });
      const res = await this.runTurn({
        prompt: s.prompt, systemPrompt: s.systemPrompt || undefined, model: s.model || undefined, mode: s.mode || undefined,
      }, label, t);
      s.response = res.text;
      s.packed.push(...(res.messages?.length ? res.messages : [{ role: "assistant" as const, content: res.text }]));
      this.emit({ type: "turn:end", workflow: ctx.name, step: label });
    }

    if (step.ref) await this.execWorkflow(step.ref, ctx, depth + 1);
    for (const n of step.actions ?? []) await this.execWorkflow(n, ctx, depth + 1);
    if (step.loop) {
      const max = Math.min(step.loop.maxIterations, 1000);
      for (let i = 0; i < max; i++) {
        if (!(await evalCondition(step.loop.while, s, this.env(), this.o.ai, t, this.o.cwd))) break;
        for (const child of step.steps ?? []) await this.execStep(child, ctx, depth + 1);
      }
    } else {
      for (const child of step.steps ?? []) await this.execStep(child, ctx, depth + 1);
    }
    this.emit({ type: "step:end", workflow: ctx.name, step: label });
  }
}
