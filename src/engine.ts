import { evalCondition, execShell, interpolate, resolveUpdater, StepTimeoutError } from "./updaters.js";
import type { AiClient, ConfirmPreview, EngineEvent, HostAdapter, Registry, RunResult, Step, WorkflowState } from "./types.js";

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
  onEvent?: (e: EngineEvent) => void;
}

interface RunCtx { name: string; state: WorkflowState; steps: number; started: number; deadline: number; maxSteps: number }

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new StepTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class WorkflowEngine {
  private readonly o: EngineOptions & Required<Pick<EngineOptions, "maxSteps" | "maxDepth" | "maxDurationMs" | "stepTimeoutMs">>;

  constructor(opts: EngineOptions) {
    // Explicit `?? default` per field: a caller passing `maxSteps: undefined` must not disable the budget.
    this.o = {
      ...opts,
      maxSteps: opts.maxSteps ?? 200,
      maxDepth: opts.maxDepth ?? 8,
      maxDurationMs: opts.maxDurationMs ?? 30 * 60_000,
      stepTimeoutMs: opts.stepTimeoutMs ?? 5 * 60_000,
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

    if ((wantsTurn || wantsShell) && step.requireConfirm) {
      const preview: ConfirmPreview = {
        workflow: ctx.name, step: label, kind: wantsShell ? "shell" : "agent-turn",
        prompt: wantsTurn ? s.prompt : undefined,
        command: wantsShell ? interpolate(step.shell as string, s, this.env()) : undefined,
        model: s.model, mode: s.mode,
      };
      const ok = this.o.confirm ? await this.o.confirm(preview) : false; // headless default: deny
      if (!ok) { this.emit({ type: "step:skip", workflow: ctx.name, step: label, reason: "confirm-denied" }); return; }
    }

    if (wantsShell) {
      const r = await execShell(interpolate(step.shell as string, s, this.env()), { env: this.env(), cwd: this.o.cwd, timeoutMs: t });
      s.response = r.stdout.trimEnd();
      s.packed.push({ role: "tool", name: "shell", content: s.response });
      if (r.code !== 0 && !step.continueOnError) throw new Error(`shell step "${label}" exited ${r.code}: ${r.stderr.trim()}`);
    } else if (wantsTurn) {
      this.emit({ type: "turn:start", workflow: ctx.name, step: label, detail: { model: s.model, mode: s.mode } });
      const res = await withTimeout(this.o.host.sendTurn({
        prompt: s.prompt, systemPrompt: s.systemPrompt || undefined, model: s.model || undefined, mode: s.mode || undefined,
      }), t, `agent turn "${label}"`);
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
