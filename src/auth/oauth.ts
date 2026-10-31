import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Config } from "../config.js";
import { PageyClient, PageyApiError } from "../pagey/client.js";
import type { PageyUser } from "../pagey/types.js";
import { decryptToken, deriveKey, encryptToken, randomToken, safeEqual, sha256, signValue, verifyValue } from "../util/crypto.js";
import type { Logger } from "../util/logger.js";
import { renderAuthorizePage, renderMessagePage } from "../http/pages.js";
import type { Connection, Store } from "./store.js";

export const PAGEY_SCOPE = "pagey:account";
const CSRF_COOKIE = "pagey_oauth_csrf";
const CSRF_MAX_AGE_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_PREFIX = "pagey_";
const MAX_REDIRECT_URIS = 10;

export interface AuthDependencies {
  config: Config;
  store: Store;
  log: Logger;
  fetchUser: (token: string) => Promise<PageyUser>;
}

export interface InstalledAuth {
  provider: OAuthServerProvider;
  requireAuth: ReturnType<typeof requireBearerAuth>;
  tokenKey: Buffer;
}

export function installOAuth(app: Express, deps: AuthDependencies): InstalledAuth {
  const { config, store, log } = deps;
  const tokenKey = deriveKey(config.secret, "pagey-token");
  const csrfKey = deriveKey(config.secret, "oauth-csrf");
  const provider = new PageyOAuthProvider(deps, tokenKey, csrfKey);

  // The SDK serves the bare RFC 9728 document for the origin. Also serve the
  // path-specific URL that some MCP clients try for `/mcp`. This must be
  // registered before the SDK metadata router, whose prefix route would
  // otherwise swallow the request.
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      resource: config.publicBaseUrl.href,
      authorization_servers: [config.publicBaseUrl.href],
      scopes_supported: [PAGEY_SCOPE],
      resource_name: "Pagey Site",
      resource_documentation: config.repoUrl,
    });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicBaseUrl,
      baseUrl: config.publicBaseUrl,
      serviceDocumentationUrl: new URL(config.repoUrl),
      scopesSupported: [PAGEY_SCOPE],
      resourceServerUrl: config.publicBaseUrl,
      resourceName: "Pagey Site",
      authorizationOptions: {
        rateLimit: { windowMs: 15 * 60 * 1000, max: 100 },
      },
      tokenOptions: {
        rateLimit: { windowMs: 15 * 60 * 1000, max: 100 },
      },
      clientRegistrationOptions: {
        rateLimit: { windowMs: 60 * 60 * 1000, max: 20 },
        clientSecretExpirySeconds: 0,
      },
    }),
  );

  const requireAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${config.publicBaseUrl.origin}/.well-known/oauth-protected-resource`,
    expectedResource: config.publicBaseUrl,
  });

  return { provider, requireAuth, tokenKey };
}

class PageyOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly skipLocalPkceValidation = false;

  constructor(
    private readonly deps: AuthDependencies,
    private readonly tokenKey: Buffer,
    private readonly csrfKey: Buffer,
  ) {
    this.clientsStore = new ClientsStore(deps.store);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestedScopes = (params.scopes ?? []).filter(Boolean);
    if (requestedScopes.some((scope) => scope !== PAGEY_SCOPE)) {
      throw new InvalidScopeError(`Only the ${PAGEY_SCOPE} scope is supported`);
    }
    const req = res.req;
    if (req.method === "GET") {
      this.renderForm(client, params, req, res);
      return;
    }
    if (req.method !== "POST") {
      res.status(405).setHeader("Allow", "GET, POST");
      res.send(renderMessagePage("Method not allowed", "Use the connection form to continue.", { status: 405 }));
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const submittedCsrf = typeof body.csrf === "string" ? body.csrf : "";
    if (!this.verifyCsrf(req, submittedCsrf)) {
      this.renderForm(client, params, req, res, "This sign-in page expired. Please try again.");
      return;
    }

    const rawToken = typeof body.pagey_token === "string" ? body.pagey_token.trim() : "";
    if (rawToken.length < 20 || rawToken.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(rawToken)) {
      this.renderForm(client, params, req, res, "Paste a valid Pagey API token from your dashboard.");
      return;
    }

    let user: PageyUser;
    try {
      user = await this.deps.fetchUser(rawToken);
    } catch (error) {
      if (error instanceof PageyApiError && error.status === 401) {
        this.renderForm(
          client,
          params,
          req,
          res,
          "Pagey did not accept that token. Check that you copied the whole token and that it has not been revoked.",
        );
      } else {
        this.deps.log.warn("Pagey token verification failed", {
          status: error instanceof PageyApiError ? error.status : 0,
        });
        this.renderForm(client, params, req, res, "Could not verify the token with Pagey right now. Try again.");
      }
      return;
    }

    let connectionId: string;
    try {
      connectionId = this.deps.store.upsertConnection({
        pageyUserId: user.id,
        pageyEmail: user.email,
        pageyTier: user.tier ?? null,
        tokenEnc: encryptToken(rawToken, this.tokenKey),
      });
    } catch (error) {
      this.deps.log.error("Could not save Pagey connection", { message: safeErrorMessage(error) });
      res.status(500).send(
        renderMessagePage("Could not connect", "The connection could not be saved. Try again in a moment."),
      );
      return;
    }

    const code = `${TOKEN_PREFIX}code_${randomToken(32)}`;
    const scopes = requestedScopes.length > 0 ? requestedScopes : [PAGEY_SCOPE];
    const resource = canonicalResource(params.resource, this.deps.config);

    this.deps.store.createAuthCode({
      codeHash: sha256(code),
      clientId: client.client_id,
      connectionId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: scopes.join(" "),
      resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    this.deps.log.info("Pagey account connected", { connectionId });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state !== undefined) redirect.searchParams.set("state", params.state);
    clearCsrfCookie(res, this.deps.config);
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.deps.store.getAuthCode(sha256(authorizationCode));
    if (!row || row.usedAt !== null || row.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (!safeEqual(row.clientId, client.client_id)) {
      throw new InvalidGrantError("Authorization code was not issued to this client");
    }
    return row.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.deps.store.getAuthCode(sha256(authorizationCode));
    if (!row || row.usedAt !== null || row.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (!safeEqual(row.clientId, client.client_id)) {
      throw new InvalidGrantError("Authorization code was not issued to this client");
    }
    if (redirectUri !== undefined && !redirectUriMatches(redirectUri, row.redirectUri)) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource !== undefined && canonicalResource(resource, this.deps.config) !== row.resource) {
      throw new InvalidGrantError("resource does not match the authorization request");
    }

    if (!this.deps.store.consumeAuthCode(row.codeHash)) {
      throw new InvalidGrantError("Authorization code has already been used");
    }
    return this.issueTokens(client.client_id, row.connectionId, row.scopes.split(" ").filter(Boolean), row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.deps.store.getToken(sha256(refreshToken));
    if (!row || row.kind !== "refresh" || row.revokedAt !== null || row.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (!safeEqual(row.clientId, client.client_id)) {
      throw new InvalidGrantError("Refresh token was not issued to this client");
    }
    if (resource !== undefined && canonicalResource(resource, this.deps.config) !== row.resource) {
      throw new InvalidGrantError("resource does not match the original grant");
    }

    if (!this.deps.store.revokeToken(row.tokenHash)) {
      throw new InvalidGrantError("Refresh token has already been used");
    }
    return this.issueTokens(client.client_id, row.connectionId, row.scopes.split(" ").filter(Boolean), row.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.deps.store.getToken(sha256(token));
    if (!row || row.kind !== "access" || row.revokedAt !== null || row.expiresAt < Date.now()) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    const connection = this.deps.store.getConnection(row.connectionId);
    if (!connection) throw new InvalidTokenError("The Pagey connection no longer exists");

    const info: AuthInfo = {
      token,
      clientId: row.clientId,
      scopes: row.scopes.split(" ").filter(Boolean),
      expiresAt: Math.floor(row.expiresAt / 1000),
      extra: {
        connectionId: connection.id,
        pageyUserId: connection.pageyUserId,
        pageyEmail: connection.pageyEmail,
        pageyTier: connection.pageyTier,
      },
    };
    if (row.resource) info.resource = new URL(row.resource);
    return info;
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.deps.store.getToken(sha256(request.token));
    if (!row) return;
    if (!safeEqual(row.clientId, client.client_id)) return;
    this.deps.store.revokeToken(row.tokenHash);
  }

  private issueTokens(clientId: string, connectionId: string, scopes: string[], resource: string | null): OAuthTokens {
    const now = Date.now();
    const accessToken = `${TOKEN_PREFIX}at_${randomToken(32)}`;
    const refreshToken = `${TOKEN_PREFIX}rt_${randomToken(48)}`;
    this.deps.store.createToken({
      tokenHash: sha256(accessToken),
      kind: "access",
      clientId,
      connectionId,
      scopes: scopes.join(" "),
      resource,
      expiresAt: now + this.deps.config.accessTokenTtlSeconds * 1000,
      createdAt: now,
    });
    this.deps.store.createToken({
      tokenHash: sha256(refreshToken),
      kind: "refresh",
      clientId,
      connectionId,
      scopes: scopes.join(" "),
      resource,
      expiresAt: now + this.deps.config.refreshTokenTtlSeconds * 1000,
      createdAt: now,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.deps.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private renderForm(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    req: Request,
    res: Response,
    error?: string,
  ): void {
    const csrf = issueCsrf(res, this.csrfKey, this.deps.config.publicBaseUrl.protocol === "https:");
    const hiddenFields: Array<[string, string]> = [
      ["client_id", client.client_id],
      ["redirect_uri", params.redirectUri],
      ["response_type", "code"],
      ["code_challenge", params.codeChallenge],
      ["code_challenge_method", "S256"],
      ["scope", ((params.scopes ?? []).filter(Boolean).length > 0 ? params.scopes ?? [] : [PAGEY_SCOPE]).join(" ")],
    ];
    if (params.state !== undefined) hiddenFields.push(["state", params.state]);
    if (params.resource) hiddenFields.push(["resource", params.resource.href]);

    let redirectHost = "the client";
    try {
      redirectHost = new URL(params.redirectUri).host;
    } catch {
      // The SDK already validated the URI; keep a safe fallback.
    }

    const cancel = new URL(params.redirectUri);
    cancel.searchParams.set("error", "access_denied");
    cancel.searchParams.set("error_description", "The user cancelled the connection");
    if (params.state !== undefined) cancel.searchParams.set("state", params.state);

    res.status(error ? 400 : 200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(
      renderAuthorizePage({
        clientName: sanitizeClientName(client.client_name),
        redirectHost,
        hiddenFields,
        csrf,
        error,
        cancelUrl: cancel.href,
      }),
    );
  }

  private verifyCsrf(req: Request, submitted: string): boolean {
    if (submitted.length < 10) return false;
    const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE];
    if (!cookie) return false;
    const payload = verifyValue(cookie, this.csrfKey);
    if (!payload) return false;
    try {
      const data = JSON.parse(payload) as { n?: unknown; t?: unknown };
      if (typeof data.n !== "string" || typeof data.t !== "number") return false;
      if (Date.now() - data.t > CSRF_MAX_AGE_MS || data.t > Date.now() + 60_000) return false;
      return safeEqual(data.n, submitted);
    } catch {
      return false;
    }
  }
}

class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: Store) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.store.getClient(clientId);
    if (!row) return undefined;
    const metadata = row.metadata as OAuthClientInformationFull;
    if (!metadata.client_id) metadata.client_id = clientId;
    return metadata;
  }

  registerClient(clientInfo: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const incoming = clientInfo as Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> & {
      client_id?: string;
      client_id_issued_at?: number;
    };
    const method = incoming.token_endpoint_auth_method ?? "none";
    if (method !== "none" && method !== "client_secret_post") {
      throw new InvalidClientMetadataError("Only public clients and client_secret_post are supported");
    }
    const redirectUris = validateRedirectUris(incoming.redirect_uris);
    const grantTypes = incoming.grant_types ?? ["authorization_code", "refresh_token"];
    if (grantTypes.some((value) => value !== "authorization_code" && value !== "refresh_token")) {
      throw new InvalidClientMetadataError("Only authorization_code and refresh_token grants are supported");
    }
    const responseTypes = incoming.response_types ?? ["code"];
    if (responseTypes.some((value) => value !== "code")) {
      throw new InvalidClientMetadataError("Only the code response type is supported");
    }

    const clientId = incoming.client_id ?? randomUUID();
    const full: OAuthClientInformationFull = {
      ...incoming,
      client_id: clientId,
      client_id_issued_at: incoming.client_id_issued_at ?? Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: method,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
    };
    this.store.registerClient(clientId, full as unknown as Record<string, unknown>);
    return full;
  }
}

function validateRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) {
    throw new InvalidClientMetadataError(`redirect_uris must contain between 1 and ${MAX_REDIRECT_URIS} entries`);
  }
  const uris: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new InvalidClientMetadataError("Each redirect URI must be a string");
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new InvalidClientMetadataError("Each redirect URI must be an absolute URL");
    }
    if (url.username || url.password) throw new InvalidClientMetadataError("Redirect URIs must not contain credentials");
    if (url.hash) throw new InvalidClientMetadataError("Redirect URIs must not contain a fragment");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new InvalidClientMetadataError("Redirect URIs must use HTTPS (localhost HTTP is allowed)");
    }
    uris.push(url.href);
  }
  return uris;
}

function issueCsrf(res: Response, key: Buffer, secure: boolean): string {
  const nonce = randomToken(18);
  const signed = signValue(JSON.stringify({ n: nonce, t: Date.now() }), key);
  res.cookie(CSRF_COOKIE, signed, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/authorize",
    maxAge: CSRF_MAX_AGE_MS,
  });
  return nonce;
}

function clearCsrfCookie(res: Response, config: Config): void {
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: true,
    secure: config.publicBaseUrl.protocol === "https:",
    sameSite: "lax",
    path: "/authorize",
  });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function canonicalResource(resource: URL | undefined, config: Config): string {
  const base = config.publicBaseUrl.origin;
  if (!resource) return base;
  const value = resource.href.replace(/\/+$/u, "");
  if (value !== base && value !== `${base}/mcp`) {
    throw new InvalidRequestError("resource must identify this Pagey MCP server");
  }
  return base;
}

function sanitizeClientName(value: string | undefined): string {
  if (!value) return "This ChatGPT plugin";
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80) || "This ChatGPT plugin";
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function decryptPageyToken(connection: Connection, tokenKey: Buffer): string {
  return decryptToken(connection.tokenEnc, tokenKey);
}

export function createPageyClient(token: string, config: Config): PageyClient {
  return new PageyClient(token, config);
}
