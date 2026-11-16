import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".venv", "venv", "vendor", "target", "__pycache__", ".cache",
]);
const KEY_FILES = ["CLAUDE.md", "AGENTS.md", "README.md", "package.json", "pyproject.toml", "Gemfile", "go.mod", "Cargo.toml"];

export interface ContextOptions {
  /** Cap on the whole output, in bytes. */
  maxBytes: number;
  /** Cap on tree entries. */
  maxEntries: number;
  /** Cap on directory depth. */
  maxDepth: number;
  /** Cap on each key-file excerpt, in bytes. */
  maxKeyFileBytes: number;
}

export interface ContextResult {
  text: string;
  entries: number;
  truncated: boolean;
}

async function excerpt(file: string, max: number): Promise<{ text: string; cut: boolean }> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buf, 0, max + 1, 0);
    return { text: buf.subarray(0, Math.min(bytesRead, max)).toString("utf8"), cut: bytesRead > max };
  } finally {
    await handle.close();
  }
}

/**
 * Local layout serializer for context injection. It reads only inside projectDir: symlinks are never followed,
 * dependency and build directories are skipped, and every output is capped. No caller-supplied paths.
 */
export async function buildContext(projectDir: string, opts: ContextOptions): Promise<ContextResult> {
  const root = await realpath(projectDir);
  const lines: string[] = [];
  let entries = 0;
  let truncated = false;

  const supercodeDir = path.join(root, ".supercode");
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > opts.maxDepth) return;
    const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (item.isSymbolicLink() || IGNORED_DIRS.has(item.name)) continue;
      if (item.isDirectory() && item.name === "run" && dir === supercodeDir) continue; // lock and ledger, not layout
      if (entries >= opts.maxEntries) {
        truncated = true;
        return;
      }
      entries++;
      lines.push(`${"  ".repeat(depth)}${item.name}${item.isDirectory() ? "/" : ""}`);
      if (item.isDirectory()) await walk(path.join(dir, item.name), depth + 1);
    }
  };
  await walk(root, 0);

  const sections: string[] = [`# Project layout (${path.basename(root)})`, ...lines];
  const keyBlocks: string[] = [];
  for (const name of KEY_FILES) {
    const file = path.join(root, name);
    let stat;
    try {
      stat = await lstat(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const { text, cut } = await excerpt(file, opts.maxKeyFileBytes);
    keyBlocks.push(`## ${name}${cut ? " (excerpt)" : ""}\n${text}`);
  }
  if (keyBlocks.length > 0) sections.push("", "# Key files", ...keyBlocks);

  let text = sections.join("\n");
  if (Buffer.byteLength(text) > opts.maxBytes) {
    text = `${Buffer.from(text).subarray(0, opts.maxBytes).toString("utf8")}\n[truncated]`;
    truncated = true;
  }
  return { text, entries, truncated };
}
