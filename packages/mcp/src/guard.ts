export type GuardCode = "busy" | "depth" | "budget" | "config";

export class GuardError extends Error {
  constructor(readonly code: GuardCode, message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export interface GuardOptions {
  /** Workflow runs allowed at once in this process. A second call fails fast with code "busy". */
  maxConcurrentRuns: number;
  /** Agent turns allowed across every run in this process. */
  maxAgentTurns: number;
  /** Wall-clock budget per run, passed to the engine as maxDurationMs. */
  runDeadlineMs: number;
  /** Nesting cap: a server whose depth is >= maxDepth refuses workflow_run. */
  maxDepth: number;
  /** This process's nesting depth, read from SCWF_MCP_DEPTH by the runtime. */
  depth: number;
}

export const DEFAULT_GUARD: Readonly<GuardOptions> = {
  maxConcurrentRuns: 1,
  maxAgentTurns: 50,
  runDeadlineMs: 15 * 60_000,
  maxDepth: 1,
  depth: 0,
};

/**
 * Process-wide limits for workflow_run. Budgets here are per server process: a child server started by a
 * nested host gets its own counters, so the runtime passes the remaining budget down through the environment.
 */
export class RunGuard {
  readonly opts: GuardOptions;
  private active = 0;
  private turns = 0;

  constructor(overrides: Partial<GuardOptions> = {}) {
    const opts: GuardOptions = { ...DEFAULT_GUARD };
    for (const key of Object.keys(overrides) as (keyof GuardOptions)[]) {
      const value = overrides[key];
      if (value !== undefined) opts[key] = value;
    }
    for (const key of Object.keys(opts) as (keyof GuardOptions)[]) {
      const value = opts[key];
      if (!Number.isFinite(value) || value < 0) {
        throw new GuardError("config", `guard option ${key} must be a non-negative finite number`);
      }
    }
    if (opts.maxConcurrentRuns < 1) throw new GuardError("config", "maxConcurrentRuns must be at least 1");
    this.opts = opts;
  }

  /** Refuses to start when this process is already nested at or beyond the cap. */
  assertCanStart(): void {
    if (this.opts.depth >= this.opts.maxDepth) {
      throw new GuardError("depth", `nested workflow_run refused: depth ${this.opts.depth} >= cap ${this.opts.maxDepth}`);
    }
  }

  /** Reserves a run slot. The returned function releases it; calling it more than once is harmless. */
  acquire(): () => void {
    if (this.active >= this.opts.maxConcurrentRuns) {
      throw new GuardError("busy", "another workflow run is in progress in this server");
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }

  /** Charges one agent turn against the process-wide budget. */
  chargeTurn(): void {
    if (this.turns >= this.opts.maxAgentTurns) {
      throw new GuardError("budget", `agent-turn budget exhausted (${this.opts.maxAgentTurns} per server process)`);
    }
    this.turns++;
  }

  get turnsRemaining(): number {
    return Math.max(0, this.opts.maxAgentTurns - this.turns);
  }

  get activeRuns(): number {
    return this.active;
  }
}
