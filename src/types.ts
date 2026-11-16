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
export interface HostAdapter { sendTurn(req: TurnRequest): Promise<TurnResult>; resetContext(): Promise<void> | void }
export interface AiClient { complete(instruction: string): Promise<string> }

export interface ConfirmPreview {
  workflow: string; step: string; kind: "agent-turn" | "shell";
  prompt?: string; command?: string; model?: string; mode?: string;
}
export interface EngineEvent { type: string; workflow?: string; step?: string; reason?: string; detail?: unknown }
export interface RunResult { state: WorkflowState; stepsExecuted: number; durationMs: number }
