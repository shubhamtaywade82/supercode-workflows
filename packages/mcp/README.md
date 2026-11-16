# @nemesis-oss/supercode-mcp

An MCP server that exposes the supercode workflow engine to Claude Code, Codex, and Cursor. It is built on `@modelcontextprotocol/server` v2 (spec 2026-07-28), and reuses `@nemesis-oss/supercode-workflows` for execution.

**Status 0.1.0.** `npm test` runs 54 tests: guard, tokens, preview, context, host, tools, the cross-process lock, the in-memory protocol, a real stdio end-to-end run, and the HTTP access gate. Nothing has been run against an installed Claude Code or Codex client yet. See *Known gaps* before relying on this.

## Tools

| Tool | Hints | Purpose |
|---|---|---|
| `workflow_list` | read-only | Lists workflows, with whether each one has side effects. A broken workflow is reported in place, not as a failure of the whole list. |
| `workflow_preview` | read-only | Describes every step, model, shell command, and HTTP call a run would make, without running anything. Returns a `confirm_token` for side-effecting workflows. |
| `workflow_run` | destructive, open-world | Runs a workflow. Side-effecting workflows need `allow_side_effects: true` and a valid `confirm_token`. |
| `context_boost` | read-only | Returns a size-capped project layout and key-file excerpts. Reads only inside the project directory. Symlinks are never followed. |

The skills tools (`skills_list`, `skills_install`) are not included. No catalog source is defined yet.

The host never chooses which CLI runs the agent turns. That is set at registration with `--host-agent`, so a tool call cannot pick a different binary.

## Run guard

Every `workflow_run` passes these checks, in this order. A refusal at any step leaves the confirmation token unspent.

1. **In-process slot.** One run at a time per server process. A second call fails fast with `busy`.
2. **Project lock.** One run at a time per *project*, across every server process. Lock file: `<project>/.supercode/run/mcp.lock`. A second session on the same project is refused with `busy`. A nested run started by a child CLI is refused too, because the parent holds the lock.
3. **Project turn ledger.** 200 agent turns per project per 24 hours by default, shared by every server on the project. Ledger: `<project>/.supercode/run/ledger.json`. When it is spent, runs are refused with `budget` before a token is consumed.
4. **Per-process turn budget.** 50 turns by default (`--max-turns`). A child server inherits the parent's remaining budget through `SCWF_MCP_TURN_BUDGET`.
5. **Wall-clock budget.** 15 minutes per run by default (`--deadline-ms`), passed to the engine as `maxDurationMs`. The engine checks it between steps only; see gap 4.
6. **Nesting cap.** A server started with `SCWF_MCP_DEPTH >= 1` refuses `workflow_run`. The leaf CLI receives `SCWF_MCP_DEPTH = depth + 1`.
7. **Output cap.** Responses are truncated at 20,000 characters, and the response reports the original length (`--max-response-chars`).

`.supercode/run/` contains its own `.gitignore`, so runtime state stays out of git.

### How the project lock behaves

- **Atomic claim.** A claim is written to a temp file and hard-linked into place, so readers never see a partial record. This needs a filesystem with hard links.
- **Holder identity is PID plus start time (Linux).** A reused PID has a different start time, so a dead holder is recognised and its lock is reclaimed. A zombie holder (exited, not yet reaped) counts as dead. Without `/proc`, a zombie holder reads as alive and blocks, which fails closed. A live holder is never reclaimed by age, because a run's length is not bounded by its deadline.
- **Agent groups are recorded, and cleared before reclaim.** Each agent process group is written into the lock as it starts, and removed as it ends. Before a dead holder's lock is reclaimed, its recorded groups are ended, but only where ownership can be proven. A group that cannot be proven or ended blocks the new run, and the error names the group ids. An orphaned agent therefore cannot run alongside a second run.
- **Dead holders are reclaimed.** A lock whose holder PID is gone, on this host, is reclaimed at once.
- **Other hosts.** A lock from another host is reclaimed only after 2 hours (`staleRemoteMs`), and never while it records agent groups, since those cannot be checked from here. An unreadable lock record always blocks. Check that no run is active, then delete it.
- **Released on exit and on signal.** The lock is released on normal exit, and on SIGINT, SIGTERM, or SIGHUP. The process then re-raises the signal, so it still dies by it.
- **Unreadable ledger fails closed.** It is treated as exhausted, never reset. Delete the file on purpose to reset the budget.

## Confirmation

`workflow_preview` issues an HMAC token. The token is bound to the exact workflow name, prompt, and definition, expires after 10 minutes, and is single-use. A workflow file edited between preview and run therefore invalidates the token.

The token enforces ordering and binds the previewed content. It is **not human approval**. A calling agent can call preview and then run in sequence. Human approval comes from the host's permission prompt, which the `destructiveHint` annotation on `workflow_run` triggers. Elicitation is not implemented.

Steps marked `requireConfirm` are skipped in MCP runs, because there is no interactive confirm callback. The preview lists them.

## Transports

- **stdio (default):** `scwf-mcp --host-agent claude`
- **HTTP:** `SCWF_MCP_TOKEN=<at least 32 characters> scwf-mcp --transport http --port 8787`. HTTP binds loopback only, requires `Authorization: Bearer <token>`, rejects non-loopback `Host` headers (DNS-rebinding defense), and rejects non-loopback `Origin` headers. Remote binding is refused.

## Registration

```bash
scwf-mcp register --host claude               # prints the command
scwf-mcp register --host codex                # prints a config.toml snippet
scwf-mcp register --host cursor --apply       # merges into .cursor/mcp.json
scwf-mcp register --host claude --apply       # runs `claude mcp add` (argv, no shell)
```

Nothing changes without `--apply`. Codex config is never written automatically. `.cursor/mcp.json` is merged, and other servers are kept. Invalid JSON there is an error, never overwritten.

## Adapter options (library API)

`ClaudeCodeAdapter` and `CodexAdapter` in the workflows package accept `env` and `extraArgs`. `extraArgs` is the intended hook for isolation flags, once you have verified them against your installed CLI version.

## Known gaps

1. **Process-group guarantees are POSIX-only, and not absolute.** On Linux and macOS, an aborted or timed-out agent turn ends its whole process group before the step fails. A descendant that calls `setsid` or `setpgid` leaves the group and is not ended. On Windows, side-effecting runs are refused, because no process-tree stop is implemented there.
2. **Nesting isolation is best-effort.** The depth token works only if the child CLI passes its environment to MCP servers it starts, and only if that child loads a supercode server at all. The project lock independently refuses a nested run while the parent holds it, so the failure mode is `busy`, not a second run. The stronger fix excludes the supercode server from leaf sub-turns with the CLI's MCP-config isolation flags, passed through `extraArgs`, once verified.
3. **Lock residuals.** Reclaiming a stale lock is rename-then-verify. A fresh claim landing in the instant between verify and restore can leave two processes briefly holding the lock. That needs a crash and a simultaneous start on the same stale file. It is documented in `src/lock.ts`, not eliminated.
4. **The run deadline is checked between steps only.** A long single turn runs until its own timeout (5 minutes by default). A run can therefore exceed `--deadline-ms` by up to one turn.
5. **Permissions are explicit.** Side-effecting runs on Claude require `--permission-mode`, and the server refuses them without it. Headless Claude turns pass `--permission-prompts none` (Claude Code 2.1.259 or later), so a prompt that nobody can answer is denied, not waited on. Codex runs with `approval_policy="never"` and `workspace-write` by default.
6. **Live evidence covers Claude only, and only through the workflows CLI.** `scripts/smoke-live.sh` ran against Claude Code 2.1.325: an `acceptEdits` write completes, `plan` writes nothing, and an unapproved shell command is denied without hanging. Codex has not been run live, and no MCP client (Claude Code or Codex) has driven this server yet. The protocol path is covered by in-memory and stdio tests.

## Development

The package depends on the workflows package through `file:../..`. Build the root first:

```bash
cd ../.. && npm run build && cd packages/mcp
npm test
```

## License

MIT.
