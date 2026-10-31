#!/usr/bin/env node
// Live end-to-end check against pagey.site.
//
//   PAGEY_API_TOKEN=... npm run e2e
//
// Starts the MCP server locally, walks the real OAuth flow, then publishes and
// updates a demo site through the MCP client. The demo site is intentionally
// left online for the README; any test form is deleted afterwards.

import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/auth/store.js";
import { createApp } from "../src/http/app.js";
import { Logger } from "../src/util/logger.js";
import { getFreePort, oauthLogin } from "../test/helpers.js";

const token = process.env.PAGEY_API_TOKEN?.trim();
if (!token) {
  console.error("PAGEY_API_TOKEN is required.");
  process.exit(2);
}

const demoHtml = readFileSync(new URL("../examples/demo/index.html", import.meta.url), "utf8");
const port = await getFreePort();
const dataDir = mkdtempSync(join(tmpdir(), "pagey-e2e-"));
const baseUrl = `http://127.0.0.1:${port}`;
const config = loadConfig({
  PORT: String(port),
  HOST: "127.0.0.1",
  PUBLIC_BASE_URL: baseUrl,
  PAGEY_API_URL: "https://pagey.site/api",
  PAGEY_SITE_DOMAIN: "pagey.site",
  DATA_DIR: dataDir,
  LOG_LEVEL: "warn",
  TRUST_PROXY: "0",
});
const log = new Logger("warn");
const store = new Store(config.dataDir);
const app = createApp(config, store, log);
const server = app.listen(port, "127.0.0.1");
await once(server, "listening");

let formId: string | undefined;

try {
  const session = await oauthLogin(baseUrl, { token });
  console.log("✓ OAuth connection established");

  const client = new Client({ name: "pagey-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${session.accessToken}` } },
  });
  await client.connect(transport);
  console.log("✓ MCP session established");

  const whoami = await client.callTool({ name: "whoami", arguments: {} });
  ensureOk("whoami", whoami);
  console.log(`✓ ${textOf(whoami).split("\n")[0]}`);

  const candidates = [
    process.env.E2E_SUBDOMAIN?.trim(),
    "chatgpt-demo",
    "chatgpt-site-builder",
    `chatgpt-demo-${Date.now().toString(36).slice(-4)}`,
  ].filter((value): value is string => Boolean(value));

  let published: Awaited<ReturnType<typeof client.callTool>> | undefined;
  let subdomain = "";
  for (const candidate of candidates) {
    const result = await client.callTool({
      name: "publish_site",
      arguments: {
        html: demoHtml,
        title: "Pagey for ChatGPT — live demo",
        subdomain: candidate,
      },
    });
    if (!result.isError) {
      published = result;
      subdomain = candidate;
      break;
    }
    const message = textOf(result);
    if (/reserved/i.test(message)) {
      console.log(`… subdomain "${candidate}" is reserved, trying another`);
      continue;
    }
    if (/already in use|already exists/i.test(message)) {
      const listedExisting = await client.callTool({
        name: "list_sites",
        arguments: { search: candidate, status: "active" },
      });
      const items = ((listedExisting.structuredContent as Record<string, unknown>)["items"] ?? []) as Array<
        Record<string, unknown>
      >;
      const existing = items.find((item) => String(item["subdomain"]) === candidate);
      if (existing) {
        const updatedExisting = await client.callTool({
          name: "update_site",
          arguments: {
            site: String(existing["site_id"]),
            html: demoHtml,
            title: "Pagey for ChatGPT — live demo",
          },
        });
        ensureOk("update_site", updatedExisting);
        published = updatedExisting;
        subdomain = candidate;
        console.log(`… reusing the existing "${candidate}" demo site`);
        break;
      }
    }
    throw new Error(`publish_site failed: ${message}`);
  }
  if (!published) throw new Error("Could not find an available demo subdomain");

  const siteId = String((published.structuredContent as Record<string, unknown>)["site_id"]);
  const siteUrl = `https://${subdomain}.pagey.site`;
  console.log(`✓ Published demo: ${siteUrl} (${siteId})`);

  await waitForLive(siteUrl, "ChatGPT writes it");
  console.log("✓ Live site serves the expected HTML");

  const update = await client.callTool({
    name: "update_site",
    arguments: {
      site: siteId,
      html: demoHtml.replace("</body>", `<!-- updated by chatgpt-pagey e2e ${new Date().toISOString()} -->\n</body>`),
      title: "Pagey for ChatGPT — live demo",
    },
  });
  ensureOk("update_site", update);
  await waitForLive(siteUrl, "updated by chatgpt-pagey e2e");
  console.log("✓ Updated content at the same URL");

  const listed = await client.callTool({ name: "list_sites", arguments: { search: subdomain } });
  ensureOk("list_sites", listed);
  if (!textOf(listed).includes(siteUrl)) throw new Error("list_sites did not return the demo site");
  console.log("✓ list_sites returned the demo site");

  const analytics = await client.callTool({ name: "get_site_analytics", arguments: { site: siteId, days: 7 } });
  ensureOk("get_site_analytics", analytics);
  console.log("✓ Analytics tool returned a result");

  const form = await client.callTool({
    name: "create_form",
    arguments: {
      title: "ChatGPT Pagey plugin test form",
      fields: [
        { name: "email", label: "Email", type: "email", required: true },
        { name: "message", label: "Message", type: "textarea", required: true },
      ],
    },
  });
  ensureOk("create_form", form);
  formId = String((form.structuredContent as Record<string, unknown>)["form_id"]);
  const submitUrl = String((form.structuredContent as Record<string, unknown>)["submit_url"]);
  const submitted = await fetch(submitUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: "smoke@example.com", message: "Hello from the Pagey e2e test." }),
  });
  if (!submitted.ok) throw new Error(`form submission failed with HTTP ${submitted.status}`);
  const forms = await client.callTool({ name: "list_forms", arguments: {} });
  ensureOk("list_forms", forms);
  if (!textOf(forms).includes("ChatGPT Pagey plugin test form")) throw new Error("list_forms did not return the test form");
  const responses = await client.callTool({ name: "get_form_responses", arguments: { form_id: formId } });
  ensureOk("get_form_responses", responses);
  if (!/1 response/u.test(textOf(responses))) throw new Error("get_form_responses did not show the submitted response");
  console.log("✓ Form create/submit/list/read tools work");

  await client.close();
  console.log(`\nDemo URL: ${siteUrl}`);
} finally {
  try {
    if (formId) {
      const response = await fetch(`https://pagey.site/api/forms/${formId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok || response.status === 204) console.log("✓ Deleted the test form");
      else console.warn(`Could not delete test form ${formId} (HTTP ${response.status})`);
    }
  } catch {
    console.warn(`Could not delete test form ${formId ?? ""}`.trim());
  }
  server.close();
  await once(server, "close");
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

function ensureOk(name: string, result: unknown): void {
  if ((result as { isError?: boolean }).isError) throw new Error(`${name} failed: ${textOf(result)}`);
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

async function waitForLive(url: string, needle: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      lastStatus = response.status;
      if (response.status === 200) {
        const html = await response.text();
        if (html.includes(needle)) return;
      }
    } catch {
      // Retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Live site ${url} did not serve the expected content (last HTTP ${lastStatus})`);
}
