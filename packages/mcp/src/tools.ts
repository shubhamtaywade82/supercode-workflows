import { WorkflowEngine } from "@nemesis-oss/supercode-workflows";
import { buildContext } from "./context.js";
import { previewWorkflow, type WorkflowPreview } from "./preview.js";
import type { Runtime } from "./runtime.js";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface WorkflowListEntry {
  name: string;
  menu?: string | string[];
  steps?: number;
  side_effects?: boolean;
  error?: string;
}

export interface PreviewResult {
  preview: WorkflowPreview;
  requires_confirmation: boolean;
  confirm_token?: string;
  expires_at?: string;
  next_step?: string;
}

export interface RunInput {
  name: string;
  prompt: string;
  allow_side_effects: boolean;
  confirm_token?: string;
}

export interface RunResult {
  name: string;
  response: string;
  truncated: boolean;
  response_chars: number;
  steps_executed: number;
  duration_ms: number;
  agent_turns_remaining: number;
}

/** Binds a token to the exact name, prompt, and definition that were previewed. */
export function confirmationBinding(name: string, prompt: string, definition: unknown): string {
  return JSON.stringify([name, prompt, definition]);
}

export function listWorkflows(rt: Runtime): { count: number; workflows: WorkflowListEntry[] } {
  const { registry } = rt.loadProject();
  const workflows = [...registry.keys()].sort().map((name): WorkflowListEntry => {
    try {
      const preview = previewWorkflow(name, "", registry);
      return { name, menu: registry.get(name)?.menu, steps: preview.steps.length, side_effects: preview.sideEffects };
    } catch (e) {
      // One broken workflow must not hide the rest of the list.
      return { name, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { count: workflows.length, workflows };
}

export function previewRun(rt: Runtime, input: { name: string; prompt: string }): PreviewResult {
  const { registry } = rt.loadProject();
  const preview = previewWorkflow(input.name, input.prompt, registry);
  if (!preview.sideEffects) return { preview, requires_confirmation: false };
  const issued = rt.tokens.issue(confirmationBinding(input.name, input.prompt, registry.get(input.name)));
  return {
    preview,
    requires_confirmation: true,
    confirm_token: issued.token,
    expires_at: issued.expiresAt,
    next_step: "call workflow_run with allow_side_effects: true and this confirm_token, unchanged",
  };
}

export async function runWorkflow(rt: Runtime, input: RunInput): Promise<RunResult> {
  rt.guard.assertCanStart();
  const { registry, env } = rt.loadProject();
  const preview = previewWorkflow(input.name, input.prompt, registry);
  const binding = confirmationBinding(input.name, input.prompt, registry.get(input.name));

  if (preview.sideEffects && !input.allow_side_effects) {
    throw new ToolError(
      "this workflow runs agent, shell, HTTP, or JS steps. Call workflow_preview, review it, then call workflow_run with allow_side_effects: true and the confirm_token",
    );
  }

  // Claude edits autonomously. Without an explicit permission mode the outcome would depend on a default, so refuse.
  if (preview.sideEffects && rt.hostKind === "claude" && rt.permissionMode === undefined) {
    throw new ToolError("Autonomous edits require an explicit --permission-mode (e.g., acceptEdits).");
  }
  // Windows cannot end an agent's process tree, so an abort could not be guaranteed. Refuse rather than degrade.
  if (preview.sideEffects && process.platform === "win32") {
    throw new ToolError(
      "side-effecting runs are refused on Windows: an aborted agent's process tree cannot be ended there, so no stop can be guaranteed",
    );
  }

  // Order: in-process slot, then the project lock (shared across processes), then the token. Every refusal before
  // the token check leaves the token unspent, so a busy or exhausted project never burns a confirmation.
  const releaseSlot = rt.guard.acquire();
  try {
    const lock = await rt.acquireProjectLock();
    try {
      if (preview.sideEffects && !rt.tokens.consume(binding, input.confirm_token ?? "")) {
        throw new ToolError(
          "confirm_token is missing, expired, already used, or was issued for a different workflow, prompt, or definition. Call workflow_preview again",
        );
      }
      const engine = new WorkflowEngine({
        host: rt.createHost(() => lock.chargeTurn()),
        registry,
        env,
        cwd: rt.projectDir,
        maxDurationMs: rt.guard.opts.runDeadlineMs,
      });
      const started = Date.now();
      const result = await engine.run(input.name, { prompt: input.prompt });
      const full = result.state.response;
      const truncated = full.length > rt.maxResponseChars;
      return {
        name: input.name,
        response: truncated ? full.slice(0, rt.maxResponseChars) : full,
        truncated,
        response_chars: full.length,
        steps_executed: result.stepsExecuted,
        duration_ms: Date.now() - started,
        agent_turns_remaining: rt.guard.turnsRemaining,
      };
    } finally {
      lock.release();
    }
  } finally {
    releaseSlot();
  }
}

export async function contextBoost(rt: Runtime, input: { max_bytes: number; max_entries: number }) {
  const ctx = await buildContext(rt.projectDir, {
    maxBytes: input.max_bytes,
    maxEntries: input.max_entries,
    maxDepth: 4,
    maxKeyFileBytes: 2_000,
  });
  return { text: ctx.text, entries: ctx.entries, truncated: ctx.truncated };
}
