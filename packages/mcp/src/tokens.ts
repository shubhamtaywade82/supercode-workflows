import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface ConfirmTokenOptions {
  /** Lifetime of an issued token. Default 10 minutes. */
  ttlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** HMAC key. Default: random per process, so tokens do not survive a restart. */
  key?: Buffer;
}

/**
 * Two-phase confirmation tokens for workflow_run. A token is an HMAC over (expiry, binding), where the binding is
 * the exact workflow name, prompt, and definition that were previewed. Tokens expire and are single-use.
 *
 * This enforces ordering and binds the previewed content, including a workflow file edited between preview and
 * run. It is not human approval. Approval comes from the host's permission prompt (destructiveHint) or from
 * elicitation where the host supports it.
 */
export class ConfirmTokens {
  private readonly key: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly spent = new Map<string, number>();

  constructor(opts: ConfirmTokenOptions = {}) {
    this.key = opts.key ?? randomBytes(32);
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  issue(binding: string): { token: string; expiresAt: string } {
    const expiresAt = this.now() + this.ttlMs;
    return {
      token: `${expiresAt}.${this.mac(binding, expiresAt)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** True exactly once for a valid, unexpired token whose binding matches. A failed check does not spend the token. */
  consume(binding: string, token: string): boolean {
    const now = this.now();
    this.prune(now);
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    const expiresAt = Number(token.slice(0, dot));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.mac(binding, expiresAt));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    if (this.spent.has(token)) return false;
    this.spent.set(token, expiresAt);
    return true;
  }

  private mac(binding: string, expiresAt: number): string {
    return createHmac("sha256", this.key).update(`${expiresAt}\n${binding}`).digest("base64url");
  }

  private prune(now: number): void {
    for (const [token, expiresAt] of this.spent) {
      if (expiresAt <= now) this.spent.delete(token);
    }
  }
}
