import { resolve } from "node:path";
import { loadWorkflows, type ExecFn, type HostAdapter, type Registry } from "@nemesis-oss/supercode-workflows";
import { GuardError, RunGuard } from "./guard.js";
import {
  createLeafHost,
  DEPTH_ENV,
  TURN_BUDGET_ENV,
  type HostKind,
  type LeafPermissionMode,
  type LeafSandbox,
} from "./host.js";
import { acquireProjectLock as acquireLock, type ProjectLock } from "./lock.js";
import { ConfirmTokens } from "./tokens.js";

export interface RuntimeOptions {
  /** Project root. Defaults to CLAUDE_PROJECT_DIR, then SCWF_PROJECT_DIR, then the working directory. */
  projectDir?: string;
  /** Home directory for global workflows. Defaults to the OS home; tests override it. */
  homeDir?: string;
  /** Which CLI runs the agent turns. Set at registration; the agent cannot choose it per call. */
  hostKind?: HostKind;
  /** Environment to read nesting variables from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  guard?: { maxConcurrentRuns?: number; maxAgentTurns?: number; runDeadlineMs?: number; maxDepth?: number };
  leaf?: { exec?: ExecFn; sandbox?: LeafSandbox; permissionMode?: LeafPermissionMode; extraArgs?: string[] };
  maxResponseChars?: number;
  tokenTtlMs?: number;
  /** Agent turns per project within one window, shared by every server process on the project. Default 200. */
  projectTurnBudget?: number;
  /** Length of the project ledger window. Default 24 hours. */
  projectTurnWindowMs?: number;
  /** Age after which a lock from another host may be reclaimed. Default 2 hours. */
  staleRemoteMs?: number;
  now?: () => number;
}

export interface Runtime {
  readonly projectDir: string;
  readonly hostKind: HostKind;
  readonly guard: RunGuard;
  readonly tokens: ConfirmTokens;
  readonly maxResponseChars: number;
  loadProject(): { registry: Registry; env: Record<string, string> };
  /** Agent host for one run. `onTurn` runs before each turn and is used to charge the project ledger. */
  createHost(onTurn?: () => void): HostAdapter;
  /** Takes the cross-process project lock. Throws GuardError "busy" or "budget". */
  acquireProjectLock(): ProjectLock;
}

const DEFAULT_MAX_RESPONSE_CHARS = 20_000;

function parseCount(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new GuardError("config", `${name} must be a non-negative integer`);
  return Number(value);
}

export function createRuntime(o: RuntimeOptions = {}): Runtime {
  const env = o.env ?? process.env;
  const depth = parseCount(DEPTH_ENV, env[DEPTH_ENV], 0);
  // A nested server may not exceed the budget its parent handed down.
  const parentBudget = env[TURN_BUDGET_ENV] === undefined ? undefined : parseCount(TURN_BUDGET_ENV, env[TURN_BUDGET_ENV], 0);
  const configuredTurns = o.guard?.maxAgentTurns;
  const maxAgentTurns = parentBudget === undefined
    ? configuredTurns
    : Math.min(configuredTurns ?? Number.POSITIVE_INFINITY, parentBudget);
  const guard = new RunGuard({ ...o.guard, depth, maxAgentTurns });

  const projectDir = resolve(o.projectDir ?? env.CLAUDE_PROJECT_DIR ?? env.SCWF_PROJECT_DIR ?? process.cwd());
  const hostKind = o.hostKind ?? "claude";
  const leaf = o.leaf ?? {};
  const tokens = new ConfirmTokens({ ttlMs: o.tokenTtlMs, now: o.now });
  const projectTurnBudget = o.projectTurnBudget ?? 200;
  const projectTurnWindowMs = o.projectTurnWindowMs ?? 24 * 60 * 60_000;
  const staleRemoteMs = o.staleRemoteMs ?? 2 * 60 * 60_000;

  return {
    projectDir,
    hostKind,
    guard,
    tokens,
    maxResponseChars: o.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS,
    loadProject() {
      const loaded = loadWorkflows({ projectRoot: projectDir, homeDir: o.homeDir });
      return { registry: loaded.registry, env: loaded.env };
    },
    createHost(onTurn?: () => void) {
      return createLeafHost({
        kind: hostKind,
        cwd: projectDir,
        depth,
        exec: leaf.exec,
        sandbox: leaf.sandbox,
        permissionMode: leaf.permissionMode,
        extraArgs: leaf.extraArgs,
      }, guard, onTurn);
    },
    acquireProjectLock() {
      return acquireLock(projectDir, {
        staleRemoteMs,
        turnBudget: projectTurnBudget,
        turnWindowMs: projectTurnWindowMs,
        now: o.now,
      });
    },
  };
}
