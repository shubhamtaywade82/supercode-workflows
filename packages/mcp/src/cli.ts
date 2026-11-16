#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { startHttp } from "./http.js";
import { applyRegistration, defaultIO, DEFAULT_PACKAGE, planRegistration, type RegisterHost } from "./register.js";
import { buildServer } from "./server.js";
import { createRuntime } from "./runtime.js";

const USAGE = `usage:
  scwf-mcp [serve] [--transport stdio|http] [--host-agent claude|codex|echo] [--project-dir DIR]
                   [--port N] [--max-turns N] [--deadline-ms N] [--max-response-chars N]
                   [--sandbox read-only|workspace-write|danger-full-access]
                   [--permission-mode default|acceptEdits|bypassPermissions|plan]
  scwf-mcp register --host claude|codex|cursor [--host-agent claude|codex] [--project-dir DIR] [--apply]

stdio is the default. HTTP needs SCWF_MCP_TOKEN (32+ characters), binds 127.0.0.1 only, and requires
Authorization: Bearer <token>. register prints the registration; nothing changes unless --apply is given.`;

const HOST_KINDS = ["claude", "codex", "echo"] as const;
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;
const TRANSPORTS = ["stdio", "http"] as const;
const REGISTER_HOSTS = ["claude", "codex", "cursor"] as const;

function fail(message: string): never {
  console.error(`scwf-mcp: ${message}`);
  process.exit(2);
}

function pick<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) fail(`--${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function optPick<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  return value === undefined ? undefined : pick(name, value, allowed, allowed[0]);
}

function intFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) fail(`--${name} must be a non-negative integer`);
  return Number(value);
}

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        transport: { type: "string" },
        port: { type: "string" },
        "host-agent": { type: "string" },
        "project-dir": { type: "string" },
        "max-turns": { type: "string" },
        "deadline-ms": { type: "string" },
        "max-response-chars": { type: "string" },
        sandbox: { type: "string" },
        "permission-mode": { type: "string" },
        host: { type: "string" },
        apply: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
const { values, positionals } = parseCli();

async function serve(): Promise<void> {
  const rt = createRuntime({
    hostKind: pick("host-agent", values["host-agent"], HOST_KINDS, "claude"),
    projectDir: values["project-dir"] === undefined ? undefined : resolve(values["project-dir"]),
    guard: {
      maxAgentTurns: intFlag("max-turns", values["max-turns"]),
      runDeadlineMs: intFlag("deadline-ms", values["deadline-ms"]),
    },
    maxResponseChars: intFlag("max-response-chars", values["max-response-chars"]),
    leaf: {
      sandbox: optPick("sandbox", values.sandbox, SANDBOX_MODES),
      permissionMode: optPick("permission-mode", values["permission-mode"], PERMISSION_MODES),
    },
  });

  const transport = pick("transport", values.transport, TRANSPORTS, "stdio");
  if (transport === "stdio") {
    serveStdio(() => buildServer(rt));
    return;
  }
  const token = process.env.SCWF_MCP_TOKEN ?? "";
  if (token.length < 32) fail("HTTP transport needs SCWF_MCP_TOKEN set to at least 32 characters");
  const running = await startHttp(rt, { port: intFlag("port", values.port) ?? 8787, token });
  console.error(`scwf-mcp: HTTP MCP endpoint ${running.url} (loopback only, bearer token required)`);
}

async function register(): Promise<void> {
  if (values.host === undefined) fail("register needs --host claude|codex|cursor");
  const host: RegisterHost = pick("host", values.host, REGISTER_HOSTS, "claude");
  const hostAgent = pick("host-agent", values["host-agent"], ["claude", "codex"] as const, host === "codex" ? "codex" : "claude");
  const plan = planRegistration(host, {
    hostAgent,
    projectDir: resolve(values["project-dir"] ?? process.cwd()),
    pkg: DEFAULT_PACKAGE,
  });
  console.log(plan.printed);
  if (!values.apply) {
    console.log("\n(dry run: nothing changed. Pass --apply to write it.)");
    return;
  }
  try {
    await applyRegistration(plan, defaultIO);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log("applied.");
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const command = positionals[0];
if (command === undefined || command === "serve") {
  await serve();
} else if (command === "register") {
  await register();
} else {
  fail(`unknown command: ${command}\n${USAGE}`);
}
