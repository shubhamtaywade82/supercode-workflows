export type Updater =
  | string
  | { text: string } | { ai: string } | { js: string }
  | { shell: string } | { command: string }
  | { url: string; headers?: Record<string, string> };

/** Smart Conditions: JS -> truthy, shell -> exit 0, HTTP -> 2xx, AI -> true/yes/1. */
export type Condition = Exclude<Updater, string | { text: string }>;

export interface Step {
  name?: string;
  enabled?: boolean;
  when?: Condition;
  prompt?: Updater;
  systemPrompt?: Updater;
  model?: string;
  mode?: string;
  run?: boolean;
  instantRun?: boolean;
  resetContext?: boolean;
  requireConfirm?: boolean;
  continueOnError?: boolean;
  timeoutMs?: number;
  shell?: string;
  ref?: string;
  actions?: string[];
  steps?: Step[];
  loop?: { while: Condition; maxIterations: number };
  /**
   * Run this shell step's command through an installed rtk binary (`rtk rewrite`). Opt-in, default false, shell steps only.
   * Host hooks do not reach engine shell steps, so this is the only way such a step is rewritten. Gate steps still gate on
   * the exit code, which the rewrite must preserve.
   */
  rtk?: boolean;
}

export interface Workflow extends Step {
  icon?: string;
  menu?: string | string[];
  voiceCommand?: string | string[];
  maxDurationMs?: number;
  maxSteps?: number;
}

export type Registry = Map<string, Workflow>;
export interface PackedMessage { role: "assistant" | "user" | "tool"; name?: string; content: string }

export interface WorkflowState {
  prompt: string; systemPrompt: string; model: string; mode: string; response: string;
  packed: PackedMessage[];
  initialPrompt: string; initialSystemPrompt: string; initialModel: string; initialMode: string;
}

export interface TurnRequest { prompt: string; systemPrompt?: string; model?: string; mode?: string }
export interface TurnResult { text: string; messages?: PackedMessage[] }
/**
 * Per-turn controls. A host must end its agent process tree when `signal` aborts, and must not settle with a result
 * after the abort. The engine does not depend on this: it bounds the wait either way.
 */
export interface TurnOptions { signal?: AbortSignal }
export interface HostAdapter { sendTurn(req: TurnRequest, opts?: TurnOptions): Promise<TurnResult>; resetContext(): Promise<void> | void }
export interface AiClient { complete(instruction: string): Promise<string> }

export interface ConfirmPreview {
  workflow: string; step: string; kind: "agent-turn" | "shell";
  prompt?: string; command?: string; model?: string; mode?: string;
}
export interface EngineEvent { type: string; workflow?: string; step?: string; reason?: string; detail?: unknown }
export interface RunResult { state: WorkflowState; stepsExecuted: number; durationMs: number }
