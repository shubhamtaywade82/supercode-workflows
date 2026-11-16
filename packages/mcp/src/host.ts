import {
  ClaudeCodeAdapter,
  CodexAdapter,
  EchoHost,
  type ExecFn,
  type HostAdapter,
  type TurnOptions,
  type TurnRequest,
  type TurnResult,
} from "@nemesis-oss/supercode-workflows";
import type { RunGuard } from "./guard.js";

export type HostKind = "claude" | "codex" | "echo";
export type LeafSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type LeafPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

/** Nesting depth of this server process. A child CLI receives depth + 1. */
export const DEPTH_ENV = "SCWF_MCP_DEPTH";
/** Remaining agent-turn budget handed to a child CLI, so nested servers share the parent's budget. */
export const TURN_BUDGET_ENV = "SCWF_MCP_TURN_BUDGET";

/**
 * Charges every agent turn before delegating: first to the project ledger (shared across processes), then to the
 * in-process guard. The abort signal passes through unchanged.
 */
export class CountingHost implements HostAdapter {
  constructor(
    private readonly inner: HostAdapter,
    private readonly guard: RunGuard,
    private readonly onTurn?: () => void,
  ) {}

  async sendTurn(req: TurnRequest, opts?: TurnOptions): Promise<TurnResult> {
    this.onTurn?.();
    this.guard.chargeTurn();
    return this.inner.sendTurn(req, opts);
  }

  resetContext(): void | Promise<void> {
    return this.inner.resetContext();
  }
}

export interface LeafOptions {
  kind: HostKind;
  cwd: string;
  /** Depth of the server creating this host. */
  depth: number;
  exec?: ExecFn;
  sandbox?: LeafSandbox;
  permissionMode?: LeafPermissionMode;
  extraArgs?: string[];
}

/**
 * Host for the agent turns that workflow_run triggers. The child CLI gets SCWF_MCP_DEPTH = depth + 1 and the
 * remaining turn budget in its environment. If that CLI loads a supercode MCP server, the child server sees the
 * depth, and any child at or beyond the cap refuses workflow_run.
 */
export function createLeafHost(o: LeafOptions, guard: RunGuard, onTurn?: () => void): HostAdapter {
  const env = { [DEPTH_ENV]: String(o.depth + 1), [TURN_BUDGET_ENV]: String(guard.turnsRemaining) };
  let inner: HostAdapter;
  if (o.kind === "claude") {
    // Headless by construction: nothing can answer a prompt, so prompts are denied rather than left waiting.
    inner = new ClaudeCodeAdapter({
      cwd: o.cwd, env, exec: o.exec, permissionMode: o.permissionMode, permissionPrompts: "none", extraArgs: o.extraArgs,
    });
  } else if (o.kind === "codex") {
    inner = new CodexAdapter({ cwd: o.cwd, env, exec: o.exec, sandbox: o.sandbox, extraArgs: o.extraArgs });
  } else {
    inner = new EchoHost();
  }
  return new CountingHost(inner, guard, onTurn);
}
