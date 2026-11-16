# @nemesis-oss/supercode-mcp

An MCP server that exposes the supercode workflow engine to Claude Code, Codex, and Cursor. It is built on `@modelcontextprotocol/server` v2 (spec 2026-07-28), and reuses `@nemesis-oss/supercode-workflows` for execution.

**Status 0.1.0.** `npm test` runs 42 tests, including an end-to-end run that spawns the built server over stdio. Nothing has been run against an installed Claude Code or Codex client yet. See *Known gaps* before relying on this.

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

- **Single-flight.** One workflow run at a time per server process. A second call fails fast with `busy`.
- **Agent-turn budget.** 50 turns per process by default (`--max-turns`). A child server inherits the parent's remaining budget through `SCWF_MCP_TURN_BUDGET`.
- **Wall-clock budget.** 15 minutes per run by default (`--deadline-ms`), passed to the engine as `maxDurationMs`.
- **Nesting cap.** A server started with `SCWF_MCP_DEPTH >= 1` refuses `workflow_run`. The leaf CLI receives `SCWF_MCP_DEPTH = depth + 1` in its environment.
- **Output cap.** Responses are truncated at 20,000 characters, and the response reports the original length (`--max-response-chars`).

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

1. **Single-flight and budgets are per process, not global.** Two host sessions run two server processes, which means two budgets and possibly two concurrent runs. A lock file in the project directory would enforce one run at a time across processes. It is not implemented.
2. **Nesting depends on two things I could not verify here.** The child CLI must pass the environment through to any MCP server it starts, and that child must load a supercode server at all. The stronger fix is to exclude the supercode server from leaf sub-turns with the CLI's MCP-config isolation flags, passed through `extraArgs` once confirmed.
3. **Timeouts do not stop agent processes.** The engine's per-turn timeout rejects the promise, but the spawned CLI keeps running. Stopping it needs an `AbortSignal` passed from `HostAdapter.sendTurn` into `execFile`. Not implemented. This is the most important fix before unattended use.
4. **The run deadline is checked between steps only.** A long single turn runs until its own timeout (5 minutes by default).
5. **Headless permissions.** Codex runs with `approval_policy="never"` and `workspace-write` by default. Claude uses its own default permission mode unless `--permission-mode` is given. In headless mode the default may deny edits.
6. **Clients not yet tested.** The protocol path is covered by in-memory and stdio tests. Claude Code and Codex have not been used as clients.

## Development

The package depends on the workflows package through `file:../..`. Build the root first:

```bash
cd ../.. && npm run build && cd packages/mcp
npm test
```

## License

MIT.
