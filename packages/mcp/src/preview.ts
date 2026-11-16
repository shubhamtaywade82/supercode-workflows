import type { Condition, Registry, Step, Updater } from "@nemesis-oss/supercode-workflows";

const MAX_SUMMARY_STEPS = 500;
const SNIPPET_CHARS = 200;

export interface StepSummary {
  path: string;
  kind: "agent-turn" | "shell" | "link" | "container";
  model?: string;
  mode?: string;
  prompt?: string;
  command?: string;
  conditions: string[];
  requireConfirm: boolean;
}

export interface WorkflowPreview {
  name: string;
  prompt: string;
  steps: StepSummary[];
  truncated: boolean;
  counts: {
    agentTurns: number;
    shellCommands: number;
    urlCalls: number;
    jsSnippets: number;
    aiCalls: number;
    confirmSteps: number;
  };
  /** True when a run executes agent turns, shell commands, HTTP calls, or JS. Such runs need confirmation. */
  sideEffects: boolean;
}

const clip = (s: string): string => (s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS)}…` : s);

function updaterKind(u: Updater): "text" | "ai" | "js" | "shell" | "url" {
  if (typeof u === "string") return "text";
  if ("text" in u) return "text";
  if ("ai" in u) return "ai";
  if ("js" in u) return "js";
  if ("shell" in u || "command" in u) return "shell";
  return "url";
}

function conditionKind(c: Condition): "js" | "shell" | "url" | "ai" {
  if ("js" in c) return "js";
  if ("shell" in c || "command" in c) return "shell";
  if ("ai" in c) return "ai";
  return "url";
}

function describeUpdater(u: Updater): string {
  if (typeof u === "string") return `text: ${clip(u)}`;
  if ("text" in u) return `text: ${clip(u.text)}`;
  if ("ai" in u) return `ai: ${clip(u.ai)}`;
  if ("js" in u) return `js: ${clip(u.js)}`;
  if ("shell" in u) return `shell: ${clip(u.shell)}`;
  if ("command" in u) return `shell: ${clip(u.command)}`;
  // Headers are omitted on purpose: they commonly carry credentials.
  return `url: ${u.url}`;
}

function describeCondition(c: Condition): string {
  if ("js" in c) return `js: ${clip(c.js)}`;
  if ("shell" in c) return `shell: ${clip(c.shell)}`;
  if ("command" in c) return `shell: ${clip(c.command)}`;
  if ("ai" in c) return `ai: ${clip(c.ai)}`;
  return `url: ${c.url}`;
}

/**
 * Describes what a run would do without executing anything. Mirrors the engine's rules for which steps send an
 * agent turn, so the preview matches execution. Linked workflows (ref/actions) are expanded; cycles are an error.
 */
export function previewWorkflow(name: string, prompt: string, registry: Registry): WorkflowPreview {
  const root = registry.get(name);
  if (!root) throw new Error(`workflow not found: ${name}`);

  const out: WorkflowPreview = {
    name,
    prompt,
    steps: [],
    truncated: false,
    counts: { agentTurns: 0, shellCommands: 0, urlCalls: 0, jsSnippets: 0, aiCalls: 0, confirmSteps: 0 },
    sideEffects: false,
  };
  const chain: string[] = [];

  const countUpdater = (u: Updater): void => {
    switch (updaterKind(u)) {
      case "shell": out.counts.shellCommands++; break;
      case "url": out.counts.urlCalls++; break;
      case "js": out.counts.jsSnippets++; break;
      case "ai": out.counts.aiCalls++; break;
      default: break;
    }
  };

  const countCondition = (c: Condition): void => {
    switch (conditionKind(c)) {
      case "shell": out.counts.shellCommands++; break;
      case "url": out.counts.urlCalls++; break;
      case "js": out.counts.jsSnippets++; break;
      case "ai": out.counts.aiCalls++; break;
    }
  };

  const record = (s: StepSummary): void => {
    if (out.steps.length >= MAX_SUMMARY_STEPS) {
      out.truncated = true;
      return;
    }
    out.steps.push(s);
  };

  const expand = (target: string, path: string): void => {
    const linked = registry.get(target);
    if (!linked) throw new Error(`${path}: linked workflow not found: ${target}`);
    if (chain.includes(target)) throw new Error(`cycle detected: ${[...chain, target].join(" -> ")}`);
    chain.push(target);
    visit(linked, `${path} -> ${target}`, true);
    chain.pop();
  };

  const visit = (step: Step, path: string, isRoot: boolean): void => {
    if (step.enabled === false) return;

    const conditions: string[] = [];
    if (step.when) {
      conditions.push(describeCondition(step.when));
      countCondition(step.when);
    }
    if (step.loop) {
      conditions.push(`loop (max ${step.loop.maxIterations}) while ${describeCondition(step.loop.while)}`);
      countCondition(step.loop.while);
    }
    if (step.prompt !== undefined) countUpdater(step.prompt);
    if (step.systemPrompt !== undefined) countUpdater(step.systemPrompt);

    const hasShell = step.shell !== undefined;
    const hasRef = step.ref !== undefined || (step.actions?.length ?? 0) > 0;
    const wantsTurn = !hasShell
      && step.ref === undefined
      && (step.run ?? step.instantRun ?? !isRoot)
      && (step.prompt !== undefined || step.run === true || step.instantRun === true);

    let kind: StepSummary["kind"] = "container";
    if (hasShell) kind = "shell";
    else if (wantsTurn) kind = "agent-turn";
    else if (hasRef) kind = "link";

    if (hasShell) out.counts.shellCommands++;
    if (wantsTurn) out.counts.agentTurns++;
    if (step.requireConfirm) out.counts.confirmSteps++;

    record({
      path,
      kind,
      model: step.model,
      mode: step.mode,
      prompt: step.prompt !== undefined ? describeUpdater(step.prompt) : undefined,
      command: step.shell,
      conditions,
      requireConfirm: step.requireConfirm === true,
    });

    if (step.ref !== undefined) expand(step.ref, `${path} (ref)`);
    for (const action of step.actions ?? []) expand(action, `${path} (action)`);
    (step.steps ?? []).forEach((child, i) => {
      visit(child, `${path}/${child.name ?? `#${i + 1}`}`, false);
    });
  };

  chain.push(name);
  visit(root, name, true);
  chain.pop();

  const c = out.counts;
  out.sideEffects = c.agentTurns + c.shellCommands + c.urlCalls + c.jsSnippets > 0;
  return out;
}
