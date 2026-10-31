import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Store } from "../src/auth/store.js";

const dir = mkdtempSync(join(tmpdir(), "pagey-store-"));
const store = new Store(dir);

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("upserts one connection per Pagey account", () => {
  const first = store.upsertConnection({
    pageyUserId: "user-1",
    pageyEmail: "one@example.com",
    pageyTier: "free",
    tokenEnc: "enc-1",
  });
  const second = store.upsertConnection({
    pageyUserId: "user-1",
    pageyEmail: "two@example.com",
    pageyTier: "free",
    tokenEnc: "enc-2",
  });
  assert.equal(first, second);
  const connection = store.getConnection(first);
  assert.equal(connection?.pageyEmail, "two@example.com");
  assert.equal(connection?.tokenEnc, "enc-2");
});

test("stores last site and clears it only for the matching site", () => {
  const id = store.upsertConnection({
    pageyUserId: "user-2",
    pageyEmail: "two@example.com",
    pageyTier: "free",
    tokenEnc: "enc",
  });
  store.setLastSite(id, "site-a");
  assert.equal(store.getConnection(id)?.lastSiteId, "site-a");
  store.clearLastSite(id, "site-b");
  assert.equal(store.getConnection(id)?.lastSiteId, "site-a");
  store.clearLastSite(id, "site-a");
  assert.equal(store.getConnection(id)?.lastSiteId, null);
});

test("round-trips OAuth clients", () => {
  store.registerClient("client-1", { client_id: "client-1", redirect_uris: ["https://example.com/cb"] });
  const client = store.getClient("client-1");
  assert.equal(client?.clientId, "client-1");
  assert.deepEqual(client?.metadata.redirect_uris, ["https://example.com/cb"]);
  assert.equal(store.getClient("missing"), undefined);
});

test("consumes authorization codes exactly once", () => {
  store.createAuthCode({
    codeHash: "hash-1",
    clientId: "client-1",
    connectionId: "connection-1",
    redirectUri: "https://example.com/cb",
    codeChallenge: "challenge",
    scopes: "pagey:account",
    resource: "https://mcp.example.com",
    expiresAt: Date.now() + 60_000,
  });
  const row = store.getAuthCode("hash-1");
  assert.equal(row?.codeChallenge, "challenge");
  assert.equal(store.consumeAuthCode("hash-1"), true);
  assert.equal(store.consumeAuthCode("hash-1"), false);
  assert.ok(store.getAuthCode("hash-1")?.usedAt);
});

test("stores and revokes tokens", () => {
  const now = Date.now();
  store.createToken({
    tokenHash: "token-1",
    kind: "refresh",
    clientId: "client-1",
    connectionId: "connection-1",
    scopes: "pagey:account",
    resource: null,
    expiresAt: now + 60_000,
    createdAt: now,
  });
  assert.equal(store.getToken("token-1")?.kind, "refresh");
  assert.equal(store.revokeToken("token-1"), true);
  assert.equal(store.revokeToken("token-1"), false);
  assert.ok(store.getToken("token-1")?.revokedAt);
});

test("cleans up expired authorization codes and unused clients", () => {
  const now = Date.now();
  store.createAuthCode({
    codeHash: "old-code",
    clientId: "old-client",
    connectionId: "connection-1",
    redirectUri: "https://example.com/cb",
    codeChallenge: "challenge",
    scopes: "pagey:account",
    resource: null,
    expiresAt: now - 2 * 60 * 60 * 1000,
  });
  store.registerClient("old-client", { client_id: "old-client", redirect_uris: ["https://example.com/cb"] });
  store.cleanup(now + 100 * 24 * 60 * 60 * 1000);
  assert.equal(store.getAuthCode("old-code"), undefined);
  assert.equal(store.getClient("old-client"), undefined);
});
