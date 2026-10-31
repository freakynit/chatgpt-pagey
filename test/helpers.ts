import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { Store } from "../src/auth/store.js";
import { createApp } from "../src/http/app.js";
import { Logger } from "../src/util/logger.js";

export const PAGEY_TEST_TOKEN = "test-pagey-token-1234567890";

export interface FakeSite {
  id: string;
  subdomain: string;
  title: string | null;
  status: string;
  isPasswordProtected: boolean;
  expiresAt: string | null;
  maintenanceMode: boolean;
  countryRestriction: { mode: string; countries: string[] };
  contentRevision: number;
  createdAt: string;
  updatedAt: string;
  lastPublishedAt: string;
  tags: string[];
  html: string;
}

export interface FakePagey {
  url: string;
  requests: Array<{ method: string; path: string; authorization: string | null }>;
  sites: Map<string, FakeSite>;
  forms: Array<{ id: string; title: string; responses: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
}

export async function startFakePagey(): Promise<FakePagey> {
  const sites = new Map<string, FakeSite>();
  const forms: FakePagey["forms"] = [];
  const requests: FakePagey["requests"] = [];
  let nextSite = 1;
  let nextForm = 1;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: req.method ?? "",
      path: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
    });

    if (!url.pathname.startsWith("/api")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${PAGEY_TEST_TOKEN}`) {
      sendJson(res, 401, { error: "Invalid credentials" });
      return;
    }

    const body = await readBody(req);

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      sendJson(res, 200, {
        user: {
          id: "pagey-user-1",
          email: "tester@example.com",
          isEmailVerified: true,
          tier: "free",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      return;
    }

    if (url.pathname === "/api/sites" && req.method === "GET") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const status = url.searchParams.get("status");
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 20)));
      let items = [...sites.values()].filter((site) => {
        if (status && site.status !== status) return false;
        if (search && !site.subdomain.toLowerCase().includes(search) && !(site.title ?? "").toLowerCase().includes(search)) {
          return false;
        }
        return true;
      });
      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const total = items.length;
      items = items.slice((page - 1) * pageSize, page * pageSize);
      sendJson(res, 200, { page, pageSize, total, items: items.map(publicSite) });
      return;
    }

    if (url.pathname === "/api/sites" && req.method === "POST") {
      const multipart = parseMultipart(body, req.headers["content-type"] ?? "");
      const subdomain = multipart.fields.get("customSubdomain") || `test-site-${nextSite}`;
      if ([...sites.values()].some((site) => site.subdomain === subdomain)) {
        sendJson(res, 409, { error: "Subdomain already in use" });
        return;
      }
      const now = new Date().toISOString();
      const site: FakeSite = {
        id: `00000000-0000-4000-8000-${String(nextSite++).padStart(12, "0")}`,
        subdomain,
        title: multipart.fields.get("title") ?? null,
        status: "active",
        isPasswordProtected: Boolean(multipart.fields.get("password")),
        expiresAt: multipart.fields.get("expiresAt") ?? null,
        maintenanceMode: false,
        countryRestriction: { mode: "off", countries: [] },
        contentRevision: 1,
        createdAt: now,
        updatedAt: now,
        lastPublishedAt: now,
        tags: [],
        html: multipart.file ? multipart.file.data.toString("utf8") : "",
      };
      sites.set(site.id, site);
      sendJson(res, 201, { site: publicSite(site) });
      return;
    }

    const siteMatch = /^\/api\/sites\/([^/]+)(?:\/(content|analytics|tags|maintenance|subdomain))?$/u.exec(url.pathname);
    if (siteMatch) {
      const site = sites.get(siteMatch[1] ?? "");
      if (!site) {
        sendJson(res, 404, { error: "Site not found" });
        return;
      }
      const action = siteMatch[2];
      if (action === "content" && req.method === "PUT") {
        const multipart = parseMultipart(body, req.headers["content-type"] ?? "");
        site.html = multipart.file ? multipart.file.data.toString("utf8") : site.html;
        site.contentRevision += 1;
        site.updatedAt = new Date().toISOString();
        sendJson(res, 200, { site: publicSite(site) });
        return;
      }
      if (action === "analytics" && req.method === "GET") {
        const from = url.searchParams.get("from") ?? new Date().toISOString();
        const to = url.searchParams.get("to") ?? new Date().toISOString();
        sendJson(res, 200, {
          analytics: {
            from,
            to,
            pageViews: 0,
            uniqueVisitors: 0,
            sessions: 0,
            daily: [],
            referrers: [],
            countries: [],
            topPages: [],
            entryPages: [],
            exitPages: [],
            devices: [],
            browsers: [],
            operatingSystems: [],
            trafficSources: [],
            trafficSourceDetails: [],
            utmSources: [],
            utmMediums: [],
            utmCampaigns: [],
          },
        });
        return;
      }
      if (action === "tags" && req.method === "PUT") {
        site.tags = (JSON.parse(body.toString("utf8")).tags as string[]) ?? [];
        sendJson(res, 200, { site: publicSite(site) });
        return;
      }
      if (action === "maintenance" && req.method === "PATCH") {
        site.maintenanceMode = Boolean(JSON.parse(body.toString("utf8")).enabled);
        sendJson(res, 200, { site: publicSite(site) });
        return;
      }
      if (action === "subdomain" && req.method === "PATCH") {
        site.subdomain = JSON.parse(body.toString("utf8")).subdomain;
        sendJson(res, 200, { site: publicSite(site) });
        return;
      }
      if (!action && req.method === "GET") {
        sendJson(res, 200, { site: publicSite(site) });
        return;
      }
      if (!action && req.method === "PATCH") {
        const patch = JSON.parse(body.toString("utf8"));
        if ("title" in patch) site.title = patch.title;
        if ("password" in patch) site.isPasswordProtected = Boolean(patch.password);
        if ("expiresAt" in patch) site.expiresAt = patch.expiresAt;
        if ("countryRestriction" in patch) site.countryRestriction = patch.countryRestriction;
        site.updatedAt = new Date().toISOString();
        sendJson(res, 200, { site: publicSite(site) });
        return;
      }
      if (!action && req.method === "DELETE") {
        site.status = "deleted";
        sendJson(res, 200, { message: "Site deleted" });
        return;
      }
    }

    if (url.pathname === "/api/forms" && req.method === "GET") {
      sendJson(res, 200, {
        page: 1,
        pageSize: 20,
        total: forms.length,
        items: forms.map((form) => ({
          id: form.id,
          title: form.title,
          status: "active",
          definition: {},
          responseCount: form.responses.length,
          siteSubdomain: null,
          siteTitle: null,
          createdAt: "2026-10-31T00:00:00.000Z",
          updatedAt: "2026-10-31T00:00:00.000Z",
        })),
      });
      return;
    }
    if (url.pathname === "/api/forms" && req.method === "POST") {
      const input = JSON.parse(body.toString("utf8"));
      const form = {
        id: `form-${nextForm++}`,
        title: input.title,
        responses: [] as Array<Record<string, unknown>>,
      };
      forms.push(form);
      sendJson(res, 201, {
        form: {
          id: form.id,
          title: form.title,
          status: "active",
          definition: input,
          createdAt: "2026-10-31T00:00:00.000Z",
          updatedAt: "2026-10-31T00:00:00.000Z",
        },
      });
      return;
    }
    const responseMatch = /^\/api\/forms\/([^/]+)\/responses$/u.exec(url.pathname);
    if (responseMatch) {
      const form = forms.find((item) => item.id === responseMatch[1]);
      if (!form) {
        sendJson(res, 404, { error: "Form not found" });
        return;
      }
      sendJson(res, 200, {
        form: { id: form.id, title: form.title, status: "active", definition: {}, createdAt: "", updatedAt: "" },
        page: 1,
        pageSize: 20,
        total: form.responses.length,
        items: form.responses,
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/api`,
    requests,
    sites,
    forms,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

export interface TestApp {
  baseUrl: string;
  config: Config;
  store: Store;
  server: Server;
  dataDir: string;
  close: () => Promise<void>;
}

export async function startTestApp(fakeApiUrl: string): Promise<TestApp> {
  const port = await getFreePort();
  const dataDir = mkdtempSync(join(tmpdir(), "pagey-app-"));
  const config = loadConfig({
    PORT: String(port),
    HOST: "127.0.0.1",
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    PAGEY_API_URL: fakeApiUrl,
    PAGEY_SITE_DOMAIN: "pagey.site",
    DATA_DIR: dataDir,
    LOG_LEVEL: "error",
    TRUST_PROXY: "0",
  });
  const store = new Store(config.dataDir);
  const app = createApp(config, store, new Logger("error"));
  const server = app.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    store,
    server,
    dataDir,
    close: async () => {
      server.close();
      await once(server, "close");
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface OAuthSession {
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  verifier: string;
}

export async function oauthLogin(
  baseUrl: string,
  options: { token?: string; clientId?: string; redirectUri?: string } = {},
): Promise<OAuthSession> {
  const redirectUri = options.redirectUri ?? "https://chatgpt.com/connector_platform_oauth_redirect";
  const clientId = options.clientId ?? (await registerClient(baseUrl, redirectUri));
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authorizeUrl = new URL("/authorize", baseUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "pagey:account");
  authorizeUrl.searchParams.set("state", "state-123");
  authorizeUrl.searchParams.set("resource", baseUrl);

  const page = await fetch(authorizeUrl, { redirect: "manual" });
  if (page.status !== 200) throw new Error(`authorize GET returned ${page.status}: ${await page.text()}`);
  const html = await page.text();
  const hidden = extractHidden(html);
  const cookie = firstCookie(page.headers.get("set-cookie"));
  if (!cookie) throw new Error("authorize page did not set a CSRF cookie");

  const form = new URLSearchParams(hidden);
  form.set("pagey_token", options.token ?? PAGEY_TEST_TOKEN);
  const post = await fetch(new URL("/authorize", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: form,
  });
  if (post.status !== 302) throw new Error(`authorize POST returned ${post.status}: ${await post.text()}`);
  const location = new URL(post.headers.get("location") ?? "");
  const code = location.searchParams.get("code");
  if (!code) throw new Error("authorize redirect did not contain a code");
  if (location.searchParams.get("state") !== "state-123") throw new Error("state was not preserved");

  const tokens = await exchangeCode(baseUrl, {
    clientId,
    code,
    verifier,
    redirectUri,
  });
  return {
    clientId,
    redirectUri,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    verifier,
  };
}

export async function registerClient(baseUrl: string, redirectUri: string): Promise<string> {
  const response = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT Test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201) throw new Error(`register returned ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as { client_id: string };
  return data.client_id;
}

export async function exchangeCode(
  baseUrl: string,
  input: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<{ access_token: string; refresh_token: string }> {
  const response = await fetch(new URL("/token", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      resource: baseUrl,
    }),
  });
  if (response.status !== 200) throw new Error(`token returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as { access_token: string; refresh_token: string };
}

export function extractHidden(html: string): Record<string, string> {
  const values: Record<string, string> = {};
  const pattern = /<input type="hidden" name="([^"]+)" value="([^"]*)">/gu;
  for (const match of html.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name && value !== undefined) values[name] = decodeHtml(value);
  }
  return values;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function firstCookie(value: string | null): string | undefined {
  if (!value) return undefined;
  return value.split(";")[0];
}

function publicSite(site: FakeSite): Record<string, unknown> {
  const { html: _html, ...rest } = site;
  return rest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks);
}

function parseMultipart(body: Buffer, contentType: string): { fields: Map<string, string>; file?: { filename: string; data: Buffer } } {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  const fields = new Map<string, string>();
  if (!boundary) return { fields };

  const delimiter = Buffer.from(`--${boundary}`);
  const crlf = Buffer.from("\r\n");
  let file: { filename: string; data: Buffer } | undefined;
  const raw = body.toString("latin1");
  const parts = raw.split(delimiter.toString("latin1"));
  for (const part of parts) {
    if (part === "" || part === "--\r\n" || part === "--") continue;
    let value = Buffer.from(part, "latin1");
    if (value.subarray(0, 2).equals(crlf)) value = value.subarray(2);
    if (value.subarray(-2).equals(crlf)) value = value.subarray(0, -2);
    const headerEnd = value.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const header = value.subarray(0, headerEnd).toString("latin1");
    const data = value.subarray(headerEnd + 4);
    const disposition = /content-disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/iu.exec(header);
    if (!disposition) continue;
    const name = disposition[1];
    const filename = disposition[2];
    if (!name) continue;
    if (filename !== undefined) {
      file = { filename, data };
    } else {
      fields.set(name, data.toString("utf8"));
    }
  }
  return { fields, file };
}

export async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}
