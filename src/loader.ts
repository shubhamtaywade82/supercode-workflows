import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Registry, Workflow } from "./types.js";

export interface LoadResult { registry: Registry; env: Record<string, string>; sources: string[] }

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(json|ya?ml)$/i.test(e.name)) out.push(p);
  }
  return out;
}

export function parseDotenv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

/** Precedence (later wins): global actions, global workflows, project actions, project workflows. */
export function loadWorkflows(opts: { projectRoot?: string; homeDir?: string; includeLegacyActions?: boolean } = {}): LoadResult {
  const root = opts.projectRoot ?? process.cwd();
  const home = opts.homeDir ?? os.homedir();
  const legacy = opts.includeLegacyActions !== false;
  const dirs = [
    ...(legacy ? [path.join(home, ".supercode", "actions")] : []),
    path.join(home, ".supercode", "workflows"),
    ...(legacy ? [path.join(root, ".supercode", "actions")] : []),
    path.join(root, ".supercode", "workflows"),
  ];
  const registry: Registry = new Map();
  const sources: string[] = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const doc: unknown = parseYaml(fs.readFileSync(file, "utf8"));
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`workflow file must be an object of named workflows: ${file}`);
      for (const [name, wf] of Object.entries(doc as Record<string, unknown>)) {
        if (!wf || typeof wf !== "object" || Array.isArray(wf)) throw new Error(`invalid workflow "${name}" in ${file}`);
        registry.set(name, wf as Workflow);
      }
      sources.push(file);
    }
  }
  return { registry, env: parseDotenv(path.join(root, ".env")), sources };
}
