import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Connection {
  id: string;
  pageyUserId: string;
  pageyEmail: string;
  pageyTier: string | null;
  tokenEnc: string;
  lastSiteId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredClient {
  clientId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  lastUsedAt: number;
}

export interface AuthCodeRow {
  codeHash: string;
  clientId: string;
  connectionId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string;
  resource: string | null;
  expiresAt: number;
  usedAt: number | null;
}

export type TokenKind = "access" | "refresh";

export interface TokenRow {
  tokenHash: string;
  kind: TokenKind;
  clientId: string;
  connectionId: string;
  scopes: string;
  resource: string | null;
  expiresAt: number;
  createdAt: number;
  revokedAt: number | null;
}

interface ConnectionRow {
  id: string;
  pagey_user_id: string;
  pagey_email: string;
  pagey_tier: string | null;
  token_enc: string;
  last_site_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ClientRow {
  client_id: string;
  metadata: string;
  created_at: number;
  last_used_at: number;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  connection_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
  used_at: number | null;
}

interface TokenRecordRow {
  token_hash: string;
  kind: string;
  client_id: string;
  connection_id: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "pagey-mcp.sqlite");
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort.
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        pagey_user_id TEXT NOT NULL UNIQUE,
        pagey_email TEXT NOT NULL,
        pagey_tier TEXT,
        token_enc TEXT NOT NULL,
        last_site_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_auth_codes_expiry ON auth_codes (expires_at);

      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        client_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_client ON tokens (client_id);
      CREATE INDEX IF NOT EXISTS idx_tokens_connection ON tokens (connection_id);
      CREATE INDEX IF NOT EXISTS idx_tokens_expiry ON tokens (expires_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Connections (one per Pagey account)
  // -------------------------------------------------------------------------

  upsertConnection(input: {
    pageyUserId: string;
    pageyEmail: string;
    pageyTier: string | null;
    tokenEnc: string;
  }): string {
    const now = Date.now();
    const row = this.db
      .prepare(
        `INSERT INTO connections (id, pagey_user_id, pagey_email, pagey_tier, token_enc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pagey_user_id) DO UPDATE SET
           pagey_email = excluded.pagey_email,
           pagey_tier = excluded.pagey_tier,
           token_enc = excluded.token_enc,
           updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(
        randomUUID(),
        input.pageyUserId,
        input.pageyEmail,
        input.pageyTier,
        input.tokenEnc,
        now,
        now,
      ) as { id: string } | undefined;
    if (!row) throw new Error("Could not save the Pagey connection");
    return row.id;
  }

  getConnection(id: string): Connection | undefined {
    const row = this.db
      .prepare("SELECT * FROM connections WHERE id = ?")
      .get(id) as ConnectionRow | undefined;
    return row ? mapConnection(row) : undefined;
  }

  setLastSite(connectionId: string, siteId: string): void {
    this.db
      .prepare("UPDATE connections SET last_site_id = ?, updated_at = ? WHERE id = ?")
      .run(siteId, Date.now(), connectionId);
  }

  clearLastSite(connectionId: string, siteId: string): void {
    this.db
      .prepare("UPDATE connections SET last_site_id = NULL, updated_at = ? WHERE id = ? AND last_site_id = ?")
      .run(Date.now(), connectionId, siteId);
  }

  // -------------------------------------------------------------------------
  // OAuth clients (dynamic client registration)
  // -------------------------------------------------------------------------

  getClient(clientId: string): { clientId: string; metadata: Record<string, unknown> } | undefined {
    const row = this.db
      .prepare("SELECT * FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as ClientRow | undefined;
    if (!row) return undefined;
    try {
      return { clientId: row.client_id, metadata: JSON.parse(row.metadata) as Record<string, unknown> };
    } catch {
      return undefined;
    }
  }

  touchClient(clientId: string): void {
    const now = Date.now();
    this.db
      .prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?")
      .run(now, clientId);
  }

  registerClient(clientId: string, metadata: Record<string, unknown>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, metadata, created_at, last_used_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET metadata = excluded.metadata`,
      )
      .run(clientId, JSON.stringify(metadata), now, now);
  }

  // -------------------------------------------------------------------------
  // Authorization codes
  // -------------------------------------------------------------------------

  createAuthCode(code: Omit<AuthCodeRow, "usedAt">): void {
    this.db
      .prepare(
        `INSERT INTO auth_codes
           (code_hash, client_id, connection_id, redirect_uri, code_challenge, scopes, resource, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        code.codeHash,
        code.clientId,
        code.connectionId,
        code.redirectUri,
        code.codeChallenge,
        code.scopes,
        code.resource,
        code.expiresAt,
      );
  }

  getAuthCode(codeHash: string): AuthCodeRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_codes WHERE code_hash = ?")
      .get(codeHash) as CodeRow | undefined;
    return row ? mapCode(row) : undefined;
  }

  consumeAuthCode(codeHash: string): boolean {
    const result = this.db
      .prepare("UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
      .run(Date.now(), codeHash);
    return Number(result.changes) === 1;
  }

  // -------------------------------------------------------------------------
  // Access and refresh tokens
  // -------------------------------------------------------------------------

  createToken(token: Omit<TokenRow, "revokedAt">): void {
    this.db
      .prepare(
        `INSERT INTO tokens
           (token_hash, kind, client_id, connection_id, scopes, resource, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        token.tokenHash,
        token.kind,
        token.clientId,
        token.connectionId,
        token.scopes,
        token.resource,
        token.expiresAt,
        token.createdAt,
      );
  }

  getToken(tokenHash: string): TokenRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE token_hash = ?")
      .get(tokenHash) as TokenRecordRow | undefined;
    return row ? mapToken(row) : undefined;
  }

  revokeToken(tokenHash: string): boolean {
    const result = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(Date.now(), tokenHash);
    return Number(result.changes) === 1;
  }

  revokeRefreshFamily(connectionId: string, clientId: string): void {
    this.db
      .prepare(
        "UPDATE tokens SET revoked_at = ? WHERE connection_id = ? AND client_id = ? AND kind = 'refresh' AND revoked_at IS NULL",
      )
      .run(Date.now(), connectionId, clientId);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  cleanup(now = Date.now()): void {
    this.db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(now - 60 * 60 * 1000);
    this.db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(now - 7 * 24 * 60 * 60 * 1000);
    const cutoff = now - 90 * 24 * 60 * 60 * 1000;
    this.db
      .prepare(
        `DELETE FROM oauth_clients
         WHERE created_at < ?
           AND client_id NOT IN (SELECT DISTINCT client_id FROM tokens)
           AND client_id NOT IN (SELECT DISTINCT client_id FROM auth_codes)`,
      )
      .run(cutoff);
  }
}

function mapConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    pageyUserId: row.pagey_user_id,
    pageyEmail: row.pagey_email,
    pageyTier: row.pagey_tier,
    tokenEnc: row.token_enc,
    lastSiteId: row.last_site_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCode(row: CodeRow): AuthCodeRow {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    connectionId: row.connection_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

function mapToken(row: TokenRecordRow): TokenRow {
  return {
    tokenHash: row.token_hash,
    kind: row.kind === "refresh" ? "refresh" : "access",
    clientId: row.client_id,
    connectionId: row.connection_id,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
