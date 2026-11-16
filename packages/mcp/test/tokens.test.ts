import test from "node:test";
import assert from "node:assert/strict";
import { ConfirmTokens } from "../src/tokens.js";

const KEY = Buffer.alloc(32, 7);

test("a token verifies once, and only for the binding it was issued for", () => {
  const tokens = new ConfirmTokens({ ttlMs: 10_000, now: () => 1_000, key: KEY });
  const { token } = tokens.issue("binding-A");
  assert.equal(tokens.consume("binding-B", token), false);   // wrong binding does not spend the token
  assert.equal(tokens.consume("binding-A", token), true);
  assert.equal(tokens.consume("binding-A", token), false);   // single use
});

test("expired tokens are refused", () => {
  let now = 1_000;
  const tokens = new ConfirmTokens({ ttlMs: 10_000, now: () => now, key: KEY });
  const { token } = tokens.issue("A");
  now = 11_000;
  assert.equal(tokens.consume("A", token), false);
});

test("a token with an altered expiry is refused", () => {
  const tokens = new ConfirmTokens({ ttlMs: 10_000, now: () => 1_000, key: KEY });
  const { token } = tokens.issue("A");
  const [expiry, mac] = token.split(".");
  assert.equal(tokens.consume("A", `${Number(expiry) + 60_000}.${mac}`), false);
});

test("tokens minted under another key are refused", () => {
  const issuer = new ConfirmTokens({ ttlMs: 10_000, now: () => 1_000, key: KEY });
  const verifier = new ConfirmTokens({ ttlMs: 10_000, now: () => 1_000, key: Buffer.alloc(32, 9) });
  assert.equal(verifier.consume("A", issuer.issue("A").token), false);
});

test("malformed tokens are refused without throwing", () => {
  const tokens = new ConfirmTokens({ key: KEY });
  for (const bad of ["", "nodot", ".x", "abc.def", "99999999999999999999999.x"]) {
    assert.equal(tokens.consume("A", bad), false, bad);
  }
});
