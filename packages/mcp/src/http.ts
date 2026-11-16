import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Runtime } from "./runtime.js";
import { buildServer } from "./server.js";

export const MCP_PATH = "/mcp";
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MIN_TOKEN_CHARS = 32;

export type AuthVerdict = { ok: true } | { ok: false; status: 401 | 403; reason: string };

/**
 * Pure access gate for the HTTP transport, tested directly. Host must be loopback (DNS-rebinding defense), an Origin
 * header, if sent, must be loopback (browser cross-origin defense), and the bearer token is compared in constant time.
 */
export function authorizeRequest(headers: IncomingHttpHeaders, token: string): AuthVerdict {
  if (!LOOPBACK_HOST.test(headers.host ?? "")) return { ok: false, status: 403, reason: "host header must be loopback" };
  if (headers.origin !== undefined && !LOOPBACK_ORIGIN.test(headers.origin)) {
    return { ok: false, status: 403, reason: "origin not allowed" };
  }
  const match = /^Bearer (.+)$/.exec(headers.authorization ?? "");
  if (!match) return { ok: false, status: 401, reason: "missing bearer token" };
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, status: 401, reason: "invalid bearer token" };
  }
  return { ok: true };
}

export interface HttpOptions {
  /** Loopback only. Remote binding is refused. */
  host?: string;
  port?: number;
  token: string;
}

export interface RunningHttp {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startHttp(rt: Runtime, opts: HttpOptions): Promise<RunningHttp> {
  if (opts.token.length < MIN_TOKEN_CHARS) {
    throw new Error(`HTTP transport needs a bearer token of at least ${MIN_TOKEN_CHARS} characters`);
  }
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("HTTP transport binds loopback only; remote binding is not supported");
  }

  const handler = createMcpHandler(() => buildServer(rt));
  const nodeHandler = toNodeHandler(handler);
  const server = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    const verdict = authorizeRequest(req.headers, opts.token);
    if (!verdict.ok) {
      res.writeHead(verdict.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: verdict.reason }));
      return;
    }
    try {
      await nodeHandler(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind the HTTP listener");

  return {
    url: `http://${host}:${address.port}${MCP_PATH}`,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handler.close();
    },
  };
}
