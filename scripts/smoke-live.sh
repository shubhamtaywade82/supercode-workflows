#!/usr/bin/env bash
# Live smoke test for the Claude and Codex hosts. It needs the real CLIs and their own authentication, so it is not part of
# `npm test`. Each live step is bounded by a timeout, so a hang is reported as a failure instead of waited on.
#
# Exit codes: 0 every step passed. 1 at least one step failed. 2 nothing failed, but some live steps were skipped
# because a CLI or its version was missing.
#
# Needs: a built tree (npm run build), `timeout` (GNU coreutils; `gtimeout` on macOS), and for live steps: claude >= 2.1.259
# (for --permission-prompts none) and/or codex, both logged in.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/src/cli.js"
RUN_TIMEOUT="${SMOKE_TIMEOUT:-600}"
MIN_CLAUDE="2.1.259"
TIMEOUT_BIN="timeout"
command -v timeout >/dev/null 2>&1 || TIMEOUT_BIN="gtimeout"
TMP="$(mktemp -d)"
PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s  (%s)\n' "$1" "$2"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s  (%s)\n' "$1" "$2"; }

if [ ! -f "$CLI" ]; then
  echo "build first: npm run build (missing $CLI)"
  exit 1
fi
if ! command -v "$TIMEOUT_BIN" >/dev/null 2>&1; then
  echo "need timeout (or gtimeout on macOS)"
  exit 1
fi

PROJ="$TMP/proj"
TARGET="$PROJ/smoke.txt"
mkdir -p "$PROJ/.supercode/workflows"
cat > "$PROJ/.supercode/workflows/smoke.yml" <<'YAML'
Write:
  steps:
    - name: write
      prompt: "Create a file named smoke.txt in the current directory whose only content is the word ready. Change nothing else."
YAML
reset() { rm -f "$TARGET"; }

# 1. Refusal. Needs no CLI: the check happens before anything is spawned.
OUT="$(node "$CLI" run Write --prompt x --host claude --dir "$PROJ" 2>&1)"
CODE=$?
if [ $CODE -eq 1 ] && printf '%s' "$OUT" | grep -q "Autonomous edits require an explicit --permission-mode"; then
  pass "claude without --permission-mode is refused before anything is spawned"
else
  fail "claude without --permission-mode is refused" "exit $CODE: $OUT"
fi

# 2. Claude live steps.
if ! command -v claude >/dev/null 2>&1; then
  skip "claude live steps" "claude is not on PATH"
else
  CVER="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ -z "$CVER" ] || [ "$(printf '%s\n%s\n' "$MIN_CLAUDE" "$CVER" | sort -V | head -1)" != "$MIN_CLAUDE" ]; then
    skip "claude live steps" "need Claude Code >= $MIN_CLAUDE for --permission-prompts none; found '${CVER:-unknown}'"
  else
    # 2a. acceptEdits must write the file, and must finish.
    reset
    "$TIMEOUT_BIN" "$RUN_TIMEOUT" node "$CLI" run Write --prompt x --host claude --permission-mode acceptEdits --dir "$PROJ" \
      >/dev/null 2>"$TMP/claude-accept.err"
    CODE=$?
    if [ $CODE -eq 124 ]; then
      fail "claude acceptEdits completes" "timed out after ${RUN_TIMEOUT}s: possible hang"
    elif [ -f "$TARGET" ] && [ "$(tr -d '[:space:]' < "$TARGET")" = "ready" ]; then
      pass "claude acceptEdits writes the file and completes"
    else
      fail "claude acceptEdits writes the file" "exit $CODE; $(tail -c 300 "$TMP/claude-accept.err")"
    fi

    # 2b. plan mode must write nothing, and a denied edit must not hang the run.
    reset
    "$TIMEOUT_BIN" "$RUN_TIMEOUT" node "$CLI" run Write --prompt x --host claude --permission-mode plan --dir "$PROJ" \
      >/dev/null 2>"$TMP/claude-plan.err"
    CODE=$?
    if [ $CODE -eq 124 ]; then
      fail "claude plan mode completes" "timed out: a denied edit hung the run"
    elif [ ! -f "$TARGET" ]; then
      pass "claude plan mode writes nothing and completes"
    else
      fail "claude plan mode writes nothing" "the file was written"
    fi

    # 2c. A shell command that acceptEdits does not auto-approve must be denied, not hang, when prompts are off.
    # acceptEdits auto-approves touch, mkdir, rm, rmdir, mv, cp and sed on in-scope paths, so those are no probe. node is
    # not on that list, so it reaches the prompt (permission-modes documentation). The reply is printed so a human can
    # confirm the command was attempted and refused; the missing file alone is a weaker signal.
    cat > "$PROJ/.supercode/workflows/bash.yml" <<'YAML'
Bash:
  steps:
    - name: bash
      prompt: "Use the shell tool to run exactly: node -e \"require('fs').writeFileSync('bashed.txt', 'x')\""
YAML
    rm -f "$PROJ/bashed.txt"
    "$TIMEOUT_BIN" "$RUN_TIMEOUT" node "$CLI" run Bash --prompt x --host claude --permission-mode acceptEdits --dir "$PROJ" \
      >"$TMP/claude-bash.out" 2>"$TMP/claude-bash.err"
    CODE=$?
    REPLY="$(grep -o '"response": "[^"]\{0,160\}' "$TMP/claude-bash.out" | head -1)"
    if [ $CODE -eq 124 ]; then
      fail "claude unapproved shell command completes" "timed out: a denied prompt hung the run"
    elif [ ! -f "$PROJ/bashed.txt" ]; then
      pass "claude acceptEdits denies an unapproved shell command and completes; reply: ${REPLY:-<none>}"
    else
      fail "claude acceptEdits denies an unapproved shell command" "bashed.txt was created"
    fi
  fi
fi

# 3. Codex live steps.
if ! command -v codex >/dev/null 2>&1; then
  skip "codex live steps" "codex is not on PATH"
else
  reset
  "$TIMEOUT_BIN" "$RUN_TIMEOUT" node "$CLI" run Write --prompt x --host codex --sandbox workspace-write --dir "$PROJ" \
    >/dev/null 2>"$TMP/codex-write.err"
  CODE=$?
  if [ $CODE -eq 124 ]; then
    fail "codex workspace-write completes" "timed out: possible approval hang"
  elif [ -f "$TARGET" ]; then
    pass "codex workspace-write writes the file and completes"
  else
    fail "codex workspace-write writes the file" "exit $CODE; $(tail -c 300 "$TMP/codex-write.err")"
  fi

  reset
  "$TIMEOUT_BIN" "$RUN_TIMEOUT" node "$CLI" run Write --prompt x --host codex --sandbox read-only --dir "$PROJ" \
    >/dev/null 2>"$TMP/codex-ro.err"
  CODE=$?
  if [ $CODE -eq 124 ]; then
    fail "codex read-only completes" "timed out"
  elif [ ! -f "$TARGET" ]; then
    pass "codex read-only writes nothing"
  else
    fail "codex read-only writes nothing" "the file was written"
  fi
fi

echo "---"
echo "passed $PASS, failed $FAIL, skipped $SKIP"
rm -rf "$TMP"
if [ $FAIL -gt 0 ]; then exit 1; fi
if [ $SKIP -gt 0 ]; then exit 2; fi
exit 0
