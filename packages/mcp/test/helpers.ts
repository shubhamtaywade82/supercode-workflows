import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecFn } from "@nemesis-oss/supercode-workflows";
import { createRuntime, type Runtime, type RuntimeOptions } from "../src/runtime.js";

export const WORKFLOWS_YAML = `Plan:
  steps:
    - name: design
      prompt: "Design: $prompt"
Empty:
  steps: []
Bad:
  steps:
    - ref: Loop
Loop:
  steps:
    - ref: Bad
`;

/** A temp project with three workflows, one of which has side effects, plus a cyclic pair. */
export async function makeProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scwf-mcp-"));
  await mkdir(path.join(dir, ".supercode", "workflows"), { recursive: true });
  await writeFile(path.join(dir, ".supercode", "workflows", "wf.yml"), WORKFLOWS_YAML);
  return dir;
}

/** Recorded Claude Code JSON envelope for a successful turn. */
export const claudeOk = (result = "done"): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "s1" });

/** Runtime isolated from the real environment: no inherited nesting variables, no real home directory. */
export function makeRuntime(dir: string, exec: ExecFn, extra: RuntimeOptions = {}): Runtime {
  return createRuntime({
    projectDir: dir,
    homeDir: path.join(dir, "no-home"),
    hostKind: "claude",
    env: {},
    leaf: { exec },
    ...extra,
  });
}
