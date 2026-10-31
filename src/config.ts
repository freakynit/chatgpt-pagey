import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Logger, type LogLevel } from "./util/logger.js";

const DEFAULT_PAGEY_API = "https://pagey.site/api";
const DEFAULT_SITE_DOMAIN = "pagey.site";
const DEFAULT_MAX_UPLOAD = 50 * 1024 * 1024;
const DEFAULT_BODY_LIMIT = 72 * 1024 * 1024;
const MIN_SECRET_LENGTH = 32;

export interface Config {
  host: string;
  port: number;
  publicBaseUrl: URL;
  pageyApiUrl: string;
  pageySiteDomain: string;
  siteProtocol: "http:" | "https:";
  dataDir: string;
  secret: string;
  trustProxy: boolean | number;
  maxUploadBytes: number;
  maxFiles: number;
  mcpBodyLimitBytes: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  logLevel: LogLevel;
  repoUrl: string;
  documentationUrl: string;
}

export const REPO_URL = "https://github.com/freakynit/chatgpt-pagey";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const logLevel = parseLogLevel(env.LOG_LEVEL);
  const log = new Logger(logLevel);

  if (env.NODE_ENV === "production" && !env.PUBLIC_BASE_URL?.trim()) {
    throw new Error("PUBLIC_BASE_URL is required in production (for example https://mcp.example.com)");
  }

  const dataDir = resolvePath(env.DATA_DIR?.trim() || "./data");
  ensurePrivateDir(dataDir);

  const port = parseInteger(env.PORT, 8787, "PORT", 1, 65_535);
  const host = env.HOST?.trim() || "127.0.0.1";

  const publicBaseUrl = parsePublicBaseUrl(env.PUBLIC_BASE_URL?.trim(), port);
  const pageyApiUrl = parsePageyApiUrl(env.PAGEY_API_URL?.trim() || DEFAULT_PAGEY_API);
  const pageySiteDomain = parseHostname(env.PAGEY_SITE_DOMAIN?.trim() || DEFAULT_SITE_DOMAIN, "PAGEY_SITE_DOMAIN");

  const maxUploadBytes = parseInteger(
    env.MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD,
    "MAX_UPLOAD_BYTES",
    1024,
    100 * 1024 * 1024,
  );
  const minimumBodyLimit = Math.ceil((maxUploadBytes * 4) / 3) + 1024 * 1024;
  const mcpBodyLimitBytes = parseInteger(
    env.MCP_BODY_LIMIT,
    Math.max(DEFAULT_BODY_LIMIT, minimumBodyLimit),
    "MCP_BODY_LIMIT",
    minimumBodyLimit,
    200 * 1024 * 1024,
  );

  const secret = loadSecret(env.PAGEY_MCP_SECRET, dataDir, log);

  const config: Config = {
    host,
    port,
    publicBaseUrl,
    pageyApiUrl,
    pageySiteDomain,
    siteProtocol: parseSiteProtocol(env.PAGEY_SITE_PROTOCOL),
    dataDir,
    secret,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    maxUploadBytes,
    maxFiles: 1000,
    mcpBodyLimitBytes,
    accessTokenTtlSeconds: parseInteger(env.OAUTH_ACCESS_TOKEN_TTL, 3600, "OAUTH_ACCESS_TOKEN_TTL", 300, 86_400),
    refreshTokenTtlSeconds: parseInteger(
      env.OAUTH_REFRESH_TOKEN_TTL,
      30 * 24 * 60 * 60,
      "OAUTH_REFRESH_TOKEN_TTL",
      3600,
      180 * 24 * 60 * 60,
    ),
    logLevel,
    repoUrl: REPO_URL,
    documentationUrl: `${publicBaseUrl.href.replace(/\/$/, "")}/`,
  };

  if (config.pageyApiUrl !== DEFAULT_PAGEY_API && !isLoopbackUrl(config.pageyApiUrl)) {
    log.warn("Using a non-default Pagey API endpoint", { endpoint: config.pageyApiUrl });
  }

  return config;
}

function parsePublicBaseUrl(raw: string | undefined, port: number): URL {
  const value = raw || `http://127.0.0.1:${port}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid absolute URL");
  }
  if (url.username || url.password) throw new Error("PUBLIC_BASE_URL must not contain credentials");
  if (url.search || url.hash) throw new Error("PUBLIC_BASE_URL must not contain a query string or fragment");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("PUBLIC_BASE_URL must be an origin without a path");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS unless it points at localhost");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PUBLIC_BASE_URL must use http or https");
  }
  return new URL(url.origin);
}

function parsePageyApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PAGEY_API_URL must be a valid absolute URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error("PAGEY_API_URL must use HTTPS unless it points at localhost");
  }
  if (url.search || url.hash) throw new Error("PAGEY_API_URL must not contain a query string or fragment");
  return url.href.replace(/\/+$/, "");
}

function parseSiteProtocol(raw: string | undefined): "http:" | "https:" {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "https" || value === "https:") return "https:";
  if (value === "http" || value === "http:") return "http:";
  throw new Error("PAGEY_SITE_PROTOCOL must be http or https");
}

function parseHostname(raw: string, name: string): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(raw) || raw.includes("..")) {
    throw new Error(`${name} must be a hostname such as pagey.site`);
  }
  return raw.toLowerCase();
}

function parseTrustProxy(raw: string | undefined): boolean | number {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "0" || value === "false" || value === "off") return false;
  if (value === "1" || value === "true" || value === "on") return true;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0 && hops <= 10) return hops;
  throw new Error("TRUST_PROXY must be 0, 1, true, or a hop count from 1 to 10");
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return "info";
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("LOG_LEVEL must be debug, info, warn, or error");
}

function loadSecret(raw: string | undefined, dataDir: string, log: Logger): string {
  if (raw !== undefined && raw.trim() !== "") {
    const secret = raw.trim();
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`PAGEY_MCP_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    return secret;
  }

  const secretPath = join(dataDir, "secret");
  if (existsSync(secretPath)) {
    const secret = readFileSync(secretPath, "utf8").trim();
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`The generated secret at ${secretPath} is invalid; remove it and restart`);
    }
    return secret;
  }

  const secret = randomBytes(48).toString("base64url");
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  log.warn("Generated a new encryption secret; keep DATA_DIR on persistent storage", {
    path: secretPath,
  });
  return secret;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

function isLoopbackUrl(raw: string): boolean {
  try {
    return isLoopbackHostname(new URL(raw).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
