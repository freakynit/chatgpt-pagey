import type { Config } from "../config.js";
import { VERSION } from "../version.js";
import type {
  Analytics,
  CreateSiteInput,
  FormDefinitionInput,
  FormList,
  FormResponseList,
  PageyForm,
  PageySite,
  PageyUser,
  SiteList,
  SiteMetadataPatch,
} from "./types.js";

const JSON_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class PageyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PageyApiError";
  }
}

interface RequestOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Thin, defensive client for the Pagey REST API.
 *
 * - The API token is only ever placed in the Authorization header.
 * - Redirects are rejected, responses are size-capped, and requests time out.
 * - Remote error bodies are reduced to a short plain-text message.
 */
export class PageyClient {
  private readonly apiUrl: string;

  constructor(
    private readonly token: string,
    private readonly config: Pick<Config, "pageyApiUrl" | "pageySiteDomain" | "siteProtocol">,
  ) {
    this.apiUrl = config.pageyApiUrl.replace(/\/+$/, "");
  }

  siteUrl(subdomain: string): string {
    return `${this.config.siteProtocol}//${subdomain}.${this.config.pageySiteDomain}`;
  }

  async me(): Promise<PageyUser> {
    const data = await this.json<{ user: PageyUser }>("/auth/me");
    return data.user;
  }

  async listSites(params: {
    page?: number;
    pageSize?: number;
    status?: "active" | "deleted" | "expired";
    search?: string;
  } = {}): Promise<SiteList> {
    const query = new URLSearchParams();
    if (params.page !== undefined) query.set("page", String(clampInteger(params.page, 1, 1_000_000)));
    if (params.pageSize !== undefined) query.set("pageSize", String(clampInteger(params.pageSize, 1, 100)));
    if (params.status) query.set("status", params.status);
    if (params.search) query.set("search", params.search.slice(0, 200));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.json<SiteList>(`/sites${suffix}`);
  }

  async getSite(siteId: string): Promise<PageySite> {
    const data = await this.json<{ site: PageySite }>(`/sites/${encodeURIComponent(siteId)}`);
    return data.site;
  }

  async createSite(input: CreateSiteInput): Promise<PageySite> {
    const form = new FormData();
    form.set("file", new Blob([toBlobPart(input.zip)], { type: "application/zip" }), "site.zip");
    if (input.title) form.set("title", input.title);
    if (input.password) form.set("password", input.password);
    if (input.expiresAt) form.set("expiresAt", input.expiresAt);
    if (input.subdomain) form.set("customSubdomain", input.subdomain);
    const data = await this.json<{ site: PageySite }>(
      "/sites",
      { method: "POST", body: form },
      { timeoutMs: UPLOAD_TIMEOUT_MS },
    );
    return data.site;
  }

  async replaceContent(siteId: string, zip: Uint8Array): Promise<PageySite> {
    const form = new FormData();
    form.set("file", new Blob([toBlobPart(zip)], { type: "application/zip" }), "site.zip");
    const data = await this.json<{ site: PageySite }>(
      `/sites/${encodeURIComponent(siteId)}/content`,
      { method: "PUT", body: form },
      { timeoutMs: UPLOAD_TIMEOUT_MS },
    );
    return data.site;
  }

  async updateSite(siteId: string, patch: SiteMetadataPatch): Promise<PageySite> {
    const data = await this.json<{ site: PageySite }>(`/sites/${encodeURIComponent(siteId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return data.site;
  }

  async deleteSite(siteId: string): Promise<void> {
    await this.json<{ message: string }>(`/sites/${encodeURIComponent(siteId)}`, { method: "DELETE" });
  }

  async setTags(siteId: string, tags: string[]): Promise<PageySite> {
    const data = await this.json<{ site: PageySite }>(`/sites/${encodeURIComponent(siteId)}/tags`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    return data.site;
  }

  async setMaintenance(siteId: string, enabled: boolean): Promise<PageySite> {
    const data = await this.json<{ site: PageySite }>(`/sites/${encodeURIComponent(siteId)}/maintenance`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return data.site;
  }

  async setSubdomain(siteId: string, subdomain: string): Promise<PageySite> {
    const data = await this.json<{ site: PageySite }>(`/sites/${encodeURIComponent(siteId)}/subdomain`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain }),
    });
    return data.site;
  }

  async getAnalytics(siteId: string, from: Date, to: Date): Promise<Analytics> {
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    const data = await this.json<{ analytics: Analytics }>(
      `/sites/${encodeURIComponent(siteId)}/analytics?${query.toString()}`,
      {},
      { maxBytes: MAX_RESPONSE_BYTES },
    );
    return data.analytics;
  }

  async createForm(input: FormDefinitionInput): Promise<PageyForm> {
    const data = await this.json<{ form: PageyForm }>("/forms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return data.form;
  }

  async listForms(params: { siteId?: string; page?: number; pageSize?: number } = {}): Promise<FormList> {
    const query = new URLSearchParams();
    if (params.siteId) query.set("siteId", params.siteId);
    if (params.page !== undefined) query.set("page", String(clampInteger(params.page, 1, 1_000_000)));
    if (params.pageSize !== undefined) query.set("pageSize", String(clampInteger(params.pageSize, 1, 100)));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.json<FormList>(`/forms${suffix}`);
  }

  async getFormResponses(
    formId: string,
    params: { page?: number; pageSize?: number; search?: string } = {},
  ): Promise<FormResponseList> {
    const query = new URLSearchParams();
    if (params.page !== undefined) query.set("page", String(clampInteger(params.page, 1, 1_000_000)));
    if (params.pageSize !== undefined) query.set("pageSize", String(clampInteger(params.pageSize, 1, 100)));
    if (params.search) query.set("search", params.search.slice(0, 200));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.json<FormResponseList>(`/forms/${encodeURIComponent(formId)}/responses${suffix}`);
  }

  private async json<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", `chatgpt-pagey/${VERSION}`);

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? JSON_TIMEOUT_MS),
      });
    } catch (error) {
      throw mapNetworkError(error);
    }

    const body = await readLimited(response, options.maxBytes ?? 2 * 1024 * 1024).catch((error: unknown) => {
      if (error instanceof PageyApiError) throw error;
      throw new PageyApiError(response.status, "Pagey returned an unreadable response. Try again.");
    });

    if (!response.ok) {
      throw mapHttpError(response, body);
    }
    if (response.status === 204 || body.trim() === "") {
      return undefined as T;
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new PageyApiError(response.status, "Pagey returned an unexpected response. Try again.");
    }
  }
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PageyApiError(response.status, "Pagey returned more data than expected.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function mapNetworkError(error: unknown): PageyApiError {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new PageyApiError(0, "Pagey did not respond in time. Check the site list before retrying a publish.");
  }
  return new PageyApiError(0, "Could not reach Pagey. Check your connection and try again.");
}

function mapHttpError(response: Response, body: string): PageyApiError {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  const remoteMessage = extractErrorMessage(body);

  switch (response.status) {
    case 400:
      return new PageyApiError(400, remoteMessage || "Pagey rejected the request. Check the site content and settings.");
    case 401:
      return new PageyApiError(
        401,
        "Pagey rejected the saved API token. Reconnect the Pagey plugin and paste a new token from https://pagey.site/dashboard/api-tokens.",
      );
    case 403:
      return new PageyApiError(403, remoteMessage || "The connected Pagey account is not allowed to perform this action.");
    case 404:
      return new PageyApiError(
        404,
        "Site or form not found. It may have been deleted. Call list_sites or list_forms to check.",
      );
    case 409:
      return new PageyApiError(
        409,
        remoteMessage || "That name is already in use. Try a different Pagey subdomain.",
      );
    case 410:
      return new PageyApiError(410, "That site or form has expired and is no longer available.");
    case 429:
      return new PageyApiError(
        429,
        retryAfter
          ? `Pagey rate limit reached. Try again in ${retryAfter} seconds.`
          : "Pagey rate limit reached. Try again shortly.",
        retryAfter,
      );
    default:
      if (response.status >= 500) {
        return new PageyApiError(
          response.status,
          "Pagey is temporarily unavailable. Try again shortly; for a publish, call list_sites before retrying.",
          retryAfter,
        );
      }
      return new PageyApiError(response.status, remoteMessage || `Pagey returned HTTP ${response.status}.`);
  }
}

function extractErrorMessage(body: string): string | undefined {
  if (!body || body.length > 20_000) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const value = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : undefined;
    return value ? cleanMessage(value) : undefined;
  } catch {
    return undefined;
  }
}

function cleanMessage(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000);
    if (delta >= 0 && delta <= 86_400) return delta;
  }
  return undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
