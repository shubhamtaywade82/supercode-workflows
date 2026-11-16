import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PACKAGE = "@nemesis-oss/supercode-mcp";
export const SERVER_KEY = "supercode";

export type RegisterHost = "claude" | "codex" | "cursor";
export interface ServerEntry { command: string; args: string[] }

/** Printed by default. Only `claude` (argv) and `cursor` (file) can be applied; Codex config is printed only. */
export type RegisterPlan =
  | { host: "claude"; printed: string; command: string[] }
  | { host: "codex"; printed: string }
  | { host: "cursor"; printed: string; file: string; entry: ServerEntry };

export interface RegisterIO {
  run(argv: string[]): Promise<number>;
  readText(file: string): Promise<string | undefined>;
  writeText(file: string, content: string): Promise<void>;
}

const tomlArray = (xs: string[]): string => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

export function planRegistration(
  host: RegisterHost,
  opts: { hostAgent: "claude" | "codex"; projectDir: string; pkg?: string },
): RegisterPlan {
  const args = ["-y", opts.pkg ?? DEFAULT_PACKAGE, "--host-agent", opts.hostAgent];
  if (host === "claude") {
    // Options come before the server name; "--" separates the command that the CLI will spawn.
    const command = ["claude", "mcp", "add", "--transport", "stdio", SERVER_KEY, "--", "npx", ...args];
    return { host, command, printed: `Claude Code (CLI default scope):\n  ${command.join(" ")}` };
  }
  if (host === "codex") {
    const printed = [
      "Codex: add to ~/.codex/config.toml, or to a project config you trust:",
      `[mcp_servers.${SERVER_KEY}]`,
      `command = "npx"`,
      `args = ${tomlArray(args)}`,
    ].join("\n");
    return { host, printed };
  }
  const entry: ServerEntry = { command: "npx", args };
  const file = path.join(opts.projectDir, ".cursor", "mcp.json");
  return {
    host,
    file,
    entry,
    printed: `Cursor: ${file}\n${JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2)}`,
  };
}

/** Merges the entry into an existing .cursor/mcp.json, keeping other servers. Invalid JSON is an error, never overwritten. */
export function mergeCursorConfig(existing: string | undefined, entry: ServerEntry): string {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(".cursor/mcp.json must contain a JSON object");
    }
    doc = parsed as Record<string, unknown>;
  }
  const current = doc.mcpServers;
  const servers = typeof current === "object" && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : {};
  doc.mcpServers = { ...servers, [SERVER_KEY]: entry };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export async function applyRegistration(plan: RegisterPlan, io: RegisterIO): Promise<void> {
  if (plan.host === "claude") {
    const code = await io.run(plan.command);
    if (code !== 0) throw new Error(`claude mcp add exited with status ${code}`);
    return;
  }
  if (plan.host === "cursor") {
    const existing = await io.readText(plan.file);
    await io.writeText(plan.file, mergeCursorConfig(existing, plan.entry));
    return;
  }
  throw new Error("Codex config is not written automatically; add the printed snippet to your config.toml");
}

export const defaultIO: RegisterIO = {
  run: (argv) => new Promise((resolve, reject) => {
    const [bin, ...rest] = argv;
    const child = spawn(bin, rest, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  }),
  readText: async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  writeText: async (file, content) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  },
};
