import test from "node:test";
import assert from "node:assert/strict";
import { GuardError, RunGuard } from "../src/guard.js";

const isCode = (code: string) => (e: unknown): boolean => e instanceof GuardError && e.code === code;

test("single-flight: a second acquire is busy until the first releases", () => {
  const guard = new RunGuard();
  const release = guard.acquire();
  assert.throws(() => guard.acquire(), isCode("busy"));
  release();
  release(); // idempotent: a double release must not free a second slot
  assert.equal(guard.activeRuns, 0);
  guard.acquire();
});

test("depth cap refuses nested starts at or beyond the cap", () => {
  assert.doesNotThrow(() => new RunGuard({ depth: 0, maxDepth: 1 }).assertCanStart());
  assert.throws(() => new RunGuard({ depth: 1, maxDepth: 1 }).assertCanStart(), isCode("depth"));
});

test("agent-turn budget is enforced across calls", () => {
  const guard = new RunGuard({ maxAgentTurns: 2 });
  guard.chargeTurn();
  guard.chargeTurn();
  assert.equal(guard.turnsRemaining, 0);
  assert.throws(() => guard.chargeTurn(), isCode("budget"));
});

test("invalid options are rejected; undefined overrides keep the defaults", () => {
  assert.throws(() => new RunGuard({ maxConcurrentRuns: 0 }), GuardError);
  assert.throws(() => new RunGuard({ runDeadlineMs: -1 }), GuardError);
  assert.throws(() => new RunGuard({ maxAgentTurns: Number.NaN }), GuardError);
  assert.equal(new RunGuard({ maxAgentTurns: undefined }).opts.maxAgentTurns, 50);
});
