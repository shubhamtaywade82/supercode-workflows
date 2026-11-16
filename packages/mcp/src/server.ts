import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Runtime } from "./runtime.js";
import { contextBoost, listWorkflows, previewRun, runWorkflow } from "./tools.js";

export const SERVER_NAME = "supercode-mcp";
export const SERVER_VERSION = "0.1.0";

// A type alias, not an interface: interfaces are not assignable to the SDK's index-signature result type.
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const failed = (error: unknown): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
});

async function guarded(fn: () => unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return failed(error);
  }
}

/**
 * Builds the MCP server. Each tool carries annotations so the host's permission system can gate calls:
 * only workflow_run is destructive and open-world.
 */
export function buildServer(rt: Runtime): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool("workflow_list", {
    title: "List workflows",
    description: "List workflows defined in the project and global .supercode/workflows directories, with whether each one has side effects.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => guarded(() => listWorkflows(rt)));

  server.registerTool("workflow_preview", {
    title: "Preview a workflow run",
    description: "Describe the steps, models, and commands a run would execute, without executing anything. Returns a confirm_token when the run has side effects.",
    inputSchema: z.object({
      name: z.string().min(1).max(200),
      prompt: z.string().max(20_000),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => guarded(() => previewRun(rt, args)));

  server.registerTool("workflow_run", {
    title: "Run a workflow",
    description: "Run a named workflow. Workflows with agent, shell, HTTP, or JS steps require allow_side_effects: true and a confirm_token from workflow_preview.",
    inputSchema: z.object({
      name: z.string().min(1).max(200),
      prompt: z.string().max(20_000),
      allow_side_effects: z.boolean().default(false),
      confirm_token: z.string().max(512).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (args) => guarded(() => runWorkflow(rt, args)));

  server.registerTool("context_boost", {
    title: "Project layout context",
    description: "Return a size-capped project layout and key-file excerpts from the project directory. Read-only.",
    inputSchema: z.object({
      max_bytes: z.number().int().min(1_000).max(60_000).default(20_000),
      max_entries: z.number().int().min(10).max(1_000).default(300),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => guarded(() => contextBoost(rt, args)));

  return server;
}
