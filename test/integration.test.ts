import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  oauthLogin,
  PAGEY_TEST_TOKEN,
  registerClient,
  startFakePagey,
  startTestApp,
  type FakePagey,
  type TestApp,
} from "./helpers.js";

let fake: FakePagey;
let app: TestApp;

before(async () => {
  fake = await startFakePagey();
  app = await startTestApp(fake.url);
});

after(async () => {
  await app.close();
  await fake.close();
});

test("publishes OAuth discovery metadata", async () => {
  const protectedResource = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(protectedResource.status, 200);
  const prm = (await protectedResource.json()) as Record<string, unknown>;
  assert.equal(prm.resource, `${app.baseUrl}/`);
  assert.deepEqual(prm.authorization_servers, [`${app.baseUrl}/`]);
  assert.equal(prm.resource_name, "Pagey Site");

  const metadata = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(metadata.status, 200);
  const doc = (await metadata.json()) as Record<string, unknown>;
  assert.equal(doc.issuer, `${app.baseUrl}/`);
  assert.equal(doc.registration_endpoint, `${app.baseUrl}/register`);
  assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
  assert.ok((doc.token_endpoint_auth_methods_supported as string[]).includes("none"));
  assert.ok((doc.grant_types_supported as string[]).includes("refresh_token"));
});

test("requires OAuth on the MCP endpoint", async () => {
  const response = await fetch(`${app.baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("rejects a bad Pagey token during authorization and a missing CSRF cookie", async () => {
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const clientId = await registerClient(app.baseUrl, redirectUri);
  const authorizeUrl = new URL("/authorize", app.baseUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", "a".repeat(43));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  const page = await fetch(authorizeUrl);
  const html = await page.text();
  const fields = new Map<string, string>();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)) {
    fields.set(match[1] ?? "", match[2] ?? "");
  }
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];

  const body = new URLSearchParams(Object.fromEntries(fields));
  body.set("pagey_token", "wrong-token-that-is-long-enough");
  const bad = await fetch(new URL("/authorize", app.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie ?? "" },
    body,
  });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /did not accept that token/);

  const noCookieBody = new URLSearchParams(Object.fromEntries(fields));
  noCookieBody.set("pagey_token", PAGEY_TEST_TOKEN);
  const noCookie = await fetch(new URL("/authorize", app.baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: noCookieBody,
  });
  assert.equal(noCookie.status, 400);
  assert.match(await noCookie.text(), /sign-in page expired/);
});

test("runs the full OAuth and MCP publishing flow", async () => {
  const session = await oauthLogin(app.baseUrl);

  const client = new Client({ name: "pagey-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${session.accessToken}` } },
  });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "create_form",
    "delete_site",
    "get_form_responses",
    "get_site",
    "get_site_analytics",
    "list_forms",
    "list_sites",
    "publish_site",
    "update_site",
    "update_site_settings",
    "whoami",
  ]);

  const whoami = await client.callTool({ name: "whoami", arguments: {} });
  assert.match(textOf(whoami), /tester@example\.com/);

  const published = await client.callTool({
    name: "publish_site",
    arguments: {
      html: "<!doctype html><html><body><h1>Hello from ChatGPT</h1></body></html>",
      title: "Test site",
      subdomain: "quiet-lime-canyon",
    },
  });
  assert.equal(published.isError, undefined);
  assert.match(textOf(published), /Published “Test site”/);
  assert.match(textOf(published), /https:\/\/quiet-lime-canyon\.pagey\.site/);
  const publishedContent = published.structuredContent as Record<string, unknown>;
  const siteId = String(publishedContent["site_id"]);
  assert.equal(siteId, "00000000-0000-4000-8000-000000000001");
  assert.equal(publishedContent["total_bytes"], 68);

  const listed = await client.callTool({ name: "list_sites", arguments: {} });
  assert.match(textOf(listed), /quiet-lime-canyon\.pagey\.site/);
  assert.equal((listed.structuredContent as Record<string, unknown>)["total"], 1);

  const updated = await client.callTool({
    name: "update_site",
    arguments: {
      site: siteId,
      html: "<!doctype html><html><body><h1>Updated</h1></body></html>",
      title: "Updated site",
    },
  });
  assert.equal(updated.isError, undefined);
  assert.match(textOf(updated), /Updated “Updated site”/);
  assert.equal(fake.sites.get(siteId)?.contentRevision, 2);
  assert.match(fake.sites.get(siteId)?.html ?? "", /Updated/);

  const settings = await client.callTool({
    name: "update_site_settings",
    arguments: { site: siteId, password: "secret1", tags: ["demo", "test"], maintenance: true },
  });
  assert.equal(settings.isError, undefined);
  assert.equal(fake.sites.get(siteId)?.isPasswordProtected, true);
  assert.equal(fake.sites.get(siteId)?.maintenanceMode, true);
  assert.deepEqual(fake.sites.get(siteId)?.tags, ["demo", "test"]);

  const analytics = await client.callTool({
    name: "get_site_analytics",
    arguments: { site: siteId, days: 7 },
  });
  assert.match(textOf(analytics), /No visits recorded/);

  const bySubdomain = await client.callTool({
    name: "get_site",
    arguments: { site: "quiet-lime-canyon" },
  });
  assert.equal(bySubdomain.isError, undefined);
  assert.match(textOf(bySubdomain), /quiet-lime-canyon\.pagey\.site/);

  const form = await client.callTool({
    name: "create_form",
    arguments: {
      title: "Contact us",
      fields: [{ name: "email", label: "Email", type: "email", required: true }],
    },
  });
  assert.equal(form.isError, undefined);
  assert.match(textOf(form), /Created form/);
  assert.equal((form.structuredContent as Record<string, unknown>)["form_id"], "form-1");

  const forms = await client.callTool({ name: "list_forms", arguments: {} });
  assert.match(textOf(forms), /Contact us/);

  const responses = await client.callTool({
    name: "get_form_responses",
    arguments: { form_id: "form-1" },
  });
  assert.match(textOf(responses), /No responses yet/);

  const refusedDelete = await client.callTool({
    name: "delete_site",
    arguments: { site: siteId, confirm: false },
  });
  assert.equal(refusedDelete.isError, true);
  assert.equal(fake.sites.get(siteId)?.status, "active");

  const deleted = await client.callTool({
    name: "delete_site",
    arguments: { site: siteId, confirm: true },
  });
  assert.equal(deleted.isError, undefined);
  assert.equal(fake.sites.get(siteId)?.status, "deleted");

  await client.close();

  const refreshResponse = await fetch(`${app.baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
      resource: app.baseUrl,
    }),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = (await refreshResponse.json()) as { access_token: string; refresh_token: string };
  assert.ok(refreshed.access_token);

  const reuse = await fetch(`${app.baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
      resource: app.baseUrl,
    }),
  });
  assert.equal(reuse.status, 400);
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}
