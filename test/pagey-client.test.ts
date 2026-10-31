import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PageyApiError, PageyClient } from "../src/pagey/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const config = {
  pageyApiUrl: "https://pagey.site/api",
  pageySiteDomain: "pagey.site",
  siteProtocol: "https:" as const,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function site(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-1",
    subdomain: "quiet-lime-canyon",
    title: "Test",
    status: "active",
    isPasswordProtected: false,
    expiresAt: null,
    maintenanceMode: false,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    tags: [],
    ...overrides,
  };
}

test("creates a site with multipart fields and a zip file", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return jsonResponse({ site: site() }, 201);
  };

  const client = new PageyClient("pagey-token-12345678901234567890", config);
  const result = await client.createSite({
    zip: new Uint8Array([1, 2, 3, 4]),
    title: "Test",
    subdomain: "quiet-lime-canyon",
    password: "secret1",
    expiresAt: "2026-12-01T00:00:00.000Z",
  });

  assert.equal(result.id, "site-1");
  assert.equal(capturedUrl, "https://pagey.site/api/sites");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer pagey-token-12345678901234567890");
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(capturedInit?.redirect, "error");
  const form = capturedInit?.body as FormData;
  assert.equal(form.get("title"), "Test");
  assert.equal(form.get("customSubdomain"), "quiet-lime-canyon");
  assert.equal(form.get("password"), "secret1");
  assert.equal(form.get("expiresAt"), "2026-12-01T00:00:00.000Z");
  const file = form.get("file") as File;
  assert.equal(file.name, "site.zip");
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4]);
});

test("builds list queries and site URLs", async () => {
  let capturedUrl = "";
  globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return jsonResponse({ page: 1, pageSize: 5, total: 1, items: [site()] });
  };
  const client = new PageyClient("token", config);
  const result = await client.listSites({ page: 1, pageSize: 5, search: "quiet", status: "active" });
  assert.equal(result.total, 1);
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/api/sites");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("pageSize"), "5");
  assert.equal(url.searchParams.get("search"), "quiet");
  assert.equal(url.searchParams.get("status"), "active");
  assert.equal(client.siteUrl("quiet-lime-canyon"), "https://quiet-lime-canyon.pagey.site");
});

test("sends metadata updates as JSON and accepts empty delete responses", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return jsonResponse({ site: site({ title: "New title" }) });
  };
  const client = new PageyClient("token", config);
  const updated = await client.updateSite("site-1", { title: "New title", password: null });
  assert.equal(updated.title, "New title");
  const patch = calls[0];
  assert.equal(patch?.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(patch?.init?.body)), { title: "New title", password: null });
  await client.deleteSite("site-1");
  assert.equal(calls[1]?.init?.method, "DELETE");
});

test("maps Pagey errors to safe, actionable messages", async () => {
  const client = new PageyClient("token", config);

  globalThis.fetch = async () =>
    jsonResponse({ error: "Invalid credentials" }, 401);
  await assert.rejects(
    () => client.me(),
    (error: unknown) => error instanceof PageyApiError && error.status === 401 && /Reconnect/.test(error.message),
  );

  globalThis.fetch = async () =>
    jsonResponse({ error: "Too many" }, 429, { "Retry-After": "42" });
  await assert.rejects(
    () => client.listSites(),
    (error: unknown) => error instanceof PageyApiError && error.status === 429 && /42 seconds/.test(error.message),
  );

  globalThis.fetch = async () => jsonResponse({ error: "<b>Bad</b> request" }, 400);
  await assert.rejects(
    () => client.getSite("site-1"),
    (error: unknown) => error instanceof PageyApiError && error.message === "Bad request",
  );

  globalThis.fetch = async () => new Response("upstream exploded", { status: 502 });
  await assert.rejects(
    () => client.getSite("site-1"),
    (error: unknown) => error instanceof PageyApiError && /temporarily unavailable/.test(error.message),
  );
});

test("rejects redirects and network failures", async () => {
  const client = new PageyClient("token", config);
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => client.me(),
    (error: unknown) => error instanceof PageyApiError && error.status === 0 && /Could not reach/.test(error.message),
  );
});

test("creates forms and reads responses", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/forms")) {
      return jsonResponse({ form: { id: "form-1", title: "Contact", status: "active", definition: {}, createdAt: "", updatedAt: "" } }, 201);
    }
    return jsonResponse({
      form: { id: "form-1", title: "Contact", status: "active", definition: {}, createdAt: "", updatedAt: "" },
      page: 1,
      pageSize: 20,
      total: 0,
      items: [],
    });
  };
  const client = new PageyClient("token", config);
  const form = await client.createForm({
    title: "Contact",
    fields: [{ name: "email", label: "Email", type: "email", required: true }],
  });
  assert.equal(form.id, "form-1");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.title, "Contact");
  assert.equal(body.fields[0].name, "email");

  const responses = await client.getFormResponses("form-1", { page: 2, search: "a@b.com" });
  assert.equal(responses.total, 0);
  const url = new URL(calls[1]?.url ?? "");
  assert.equal(url.pathname, "/api/forms/form-1/responses");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("search"), "a@b.com");
});
