# @nemesis-oss/supercode-workflows

A deterministic, host-agnostic workflow executor for AI coding agents. Steps run in a fixed order unless an explicit condition fails, each agent turn sees only its own step, and AI steps can run on a local Ollama model. Adapters exist for Claude Code and Codex headless modes, plus test doubles.

## Provenance and affiliation

- This is an independent implementation of workflow semantics described in publicly available product documentation. It contains no source code from Supercode and vendors none.
- It is **not affiliated with, endorsed by, or sponsored by supercode.sh**. The name "Supercode" appears only to identify the documented behavior this package mirrors.
- This is not a clean-room implementation in the strict sense. The author also studied Supercode's shipped client code while researching the product. The claim here is limited to what is true: no Supercode code is copied into this repository.
- No third-party code is bundled. The optional `rtk: true` step option invokes an `rtk` binary that you install yourself. The binary is run, never vendored or linked, and its own licence applies to it. The adapter is written against the `rtk-oss` edition (Apache-2.0). Check the licence before pointing `--rtk-bin` at any other edition: the full edition's engine is BUSL-1.1.

## Status: 0.1.0

- Verified by the test suite (`npm test`, 21 `node:test` behavioral tests): engine semantics, updaters, conditions, budgets, loader, confirm gate, URL/AI updaters against local test servers and mocks, and Claude Code / Codex adapter parsing against recorded event fixtures.
- Not verified against live services: the adapter tests use recorded fixtures, not installed CLIs. CLI flag names (`--sandbox`, `--permission-mode`) and authentication have not been checked against specific CLI releases. The Ollama and OpenAI-compatible clients are not exercised by tests.

## Usage

```bash
npm install
npm run build
npx scwf list --dir ./my-project
npx scwf run "Plan Then Build" --prompt "add rate limiting" --host echo --dir ./my-project
```

Hosts: `--host echo` (no agent, for dry runs), `--host claude`, `--host codex`.
Sandbox: `--sandbox read-only|workspace-write|danger-full-access` applies only to `--host codex`.
Permissions: `--permission-mode default|acceptEdits|bypassPermissions|plan` applies only to `--host claude`.
RTK: `--rtk-bin <path>` names the rtk binary (default: `rtk` on `PATH`). Only shell steps that set `rtk: true` use it. See Security model.
Invalid values, or a flag used with the wrong host, exit with an error rather than falling back to a default.
AI steps: `--ai ollama --ollama-model <model>` or `--ai openai` (reads `OPENAI_BASE_URL` / `OPENAI_API_KEY`).

## Workflow files

Workflows are YAML or JSON files of named workflows under `~/.supercode/workflows/` (global) and `.supercode/workflows/` (project). Project definitions override global ones with the same name. A `.env` file in the project root supplies `$env.NAME` values.

```yaml
Plan Then Build:
  model: o3
  mode: architect
  steps:
    - name: design
      prompt: "Design the implementation plan for: $prompt"
    - name: implement
      model: claude-4-sonnet
      mode: code
      prompt: "Implement the plan: $response"
    - name: test-gate
      shell: npm test
```

Variables: `$prompt`, `$systemPrompt`, `$response`, `$packedResponses`, `$model`, `$mode`, and `$initial*` for the originals. Updaters: plain text, `{ ai }`, `{ shell }`, `{ url }` (POST JSON), `{ js }`. Conditions (`when`, `loop.while`): JS truthy, shell exit 0, HTTP 2xx, AI `true|yes|1`. Failed checks fail closed.

## Security model

- Workflows are trusted code, as in any agent-automation system. Review workflow files before running them.
- `shell` steps run under `/bin/bash` with your privileges.
- `--host codex` runs `codex exec` with `--sandbox workspace-write` and `approval_policy="never"` by default. Agent steps can edit files in the project, and actions that would need an approval prompt fail instead of blocking the run. The sandbox and approval flags were checked against the Codex source, not against a live run.
- `--host claude` requires an explicit `--permission-mode`. The CLI refuses a Claude run without one, before anything is spawned. Headless Claude turns pass `--permission-prompts none` (Claude Code 2.1.259 or later), so a prompt that nobody can answer is denied instead of waiting. Run autonomous workflows in an isolated checkout or runner.
- Agent turns and shell steps run in the project directory (`--dir`). Before this was fixed, the CLI ran them in the process's working directory.
- Claude captures `--append-system-prompt` on a session's first request. `ClaudeCodeAdapter` starts a new session whenever a step's system prompt differs from the current session's, so per-step `systemPrompt` values take effect. The cost is that Claude's internal conversation memory resets at that point. Cross-step context is carried by `$packedResponses`.
- `js` snippets run in `node:vm` with a timeout. `vm` is not a security boundary.
- `url` updaters and conditions send the current prompt and response to the URL you configure.
- Steps marked `requireConfirm` are denied unless a `confirm` callback approves them.
- Agent turns and shell steps run as the leader of their own process group. A timeout or abort ends the whole group (SIGTERM, then SIGKILL after a grace period) before the step fails, so no child process keeps writing to the project after a reported failure. Hosts receive an abort signal and must honor it; if a host does not confirm the stop within `abortConfirmMs`, the step fails anyway.
- A shell step can opt in with `rtk: true`. The engine runs `rtk rewrite <command>` and runs the printed command in place of the original. `rtk --version` is probed once per run, and `RTK_TELEMETRY_DISABLED=1` is set for every rtk call. Exit 0 uses the rewrite. Exit 1 runs the original command, unless stdout is non-empty or stderr carries rtk's integrity-check refusal, which refuses the command. Exit 2 (deny) and exit 3 (ask, which a headless run cannot answer) refuse the command. Any other exit code, an empty rewrite, or a missing or failing rtk also refuses it, and nothing runs. The step gates on the exit code of the command that ran, never on parsed output. Shell steps run through the engine rather than the host CLI, so a host's own rtk hook does not apply to them. Without `rtk: true`, a shell step is not rewritten. The rewrite protocol comes from upstream's own tests. It has not been checked against a live rtk install here, so the test suite uses a stub binary.

## License

MIT. See [LICENSE](./LICENSE).
