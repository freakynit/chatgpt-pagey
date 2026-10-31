#!/usr/bin/env node
// Verify a deployed Pagey MCP server over its public HTTPS endpoint.
//
//   MCP_BASE_URL=https://mcp.pagey.site PAGEY_API_TOKEN=... npm run smoke:remote
//
// By default it updates the existing `chatgpt-demo` site instead of creating a
// new one. Set SMOKE_CREATE=1 to publish a new demo if it does not exist.

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { oauthLogin } from "../test/helpers.js";

const token = process.env.PAGEY_API_TOKEN?.trim();
if (!token) {
  console.error("PAGEY_API_TOKEN is required.");
  process.exit(2);
}
const baseUrl = (process.env.MCP_BASE_URL?.trim() || "https://mcp.pagey.site").replace(/\/+$/, "");
const subdomain = (process.env.E2E_SUBDOMAIN?.trim() || "chatgpt-demo").toLowerCase();
const create = process.env.SMOKE_CREATE === "1";
const demoHtml = readFileSync(new URL("../examples/demo/index.html", import.meta.url), "utf8");

let formId: string | undefined;
const client = new Client({ name: "pagey-remote-smoke", version: "1.0.0" });

try {
  const session = await oauthLogin(baseUrl, { token });
  console.log(`✓ OAuth connection established with ${baseUrl}`);

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${session.accessToken}` } },
  });
  await client.connect(transport);
  console.log("✓ MCP session established");

  const whoami = await client.callTool({ name: "whoami", arguments: {} });
  ensureOk("whoami", whoami);
  console.log(`✓ ${textOf(whoami).split("\n")[0]}`);

  const listed = await client.callTool({
    name: "list_sites",
    arguments: { search: subdomain, status: "active" },
  });
  ensureOk("list_sites", listed);
  const items = ((listed.structuredContent as Record<string, unknown>)["items"] ?? []) as Array<
    Record<string, unknown>
  >;
  let existing = items.find((item) => String(item["subdomain"]) === subdomain);

  if (!existing) {
    if (!create) {
      throw new Error(
        `No active site named "${subdomain}". Set E2E_SUBDOMAIN to an existing site, or SMOKE_CREATE=1 to create one.`,
      );
    }
    const published = await client.callTool({
      name: "publish_site",
      arguments: { html: demoHtml, title: "Pagey for ChatGPT — remote smoke", subdomain },
    });
    ensureOk("publish_site", published);
    console.log(`✓ Published ${subdomain}.pagey.site`);
    existing = published.structuredContent as Record<string, unknown>;
  }

  const siteId = String(existing["site_id"]);
  const marker = `remote smoke ${new Date().toISOString()}`;
  const updated = await client.callTool({
    name: "update_site",
    arguments: {
      site: siteId,
      html: demoHtml.replace("</body>", `<!-- ${marker} -->\n</body>`),
      title: "Pagey for ChatGPT — live demo",
    },
  });
  ensureOk("update_site", updated);
  const siteUrl = `https://${subdomain}.pagey.site`;
  await waitForLive(`${siteUrl}/?smoke=${Date.now()}`, marker);
  console.log(`✓ Updated and served ${siteUrl}`);

  const analytics = await client.callTool({
    name: "get_site_analytics",
    arguments: { site: siteId, days: 7 },
  });
  ensureOk("get_site_analytics", analytics);
  console.log("✓ Analytics tool responded");

  const form = await client.callTool({
    name: "create_form",
    arguments: {
      title: `Remote smoke form ${Date.now()}`,
      fields: [{ name: "email", label: "Email", type: "email", required: true }],
    },
  });
  ensureOk("create_form", form);
  formId = String((form.structuredContent as Record<string, unknown>)["form_id"]);
  const forms = await client.callTool({ name: "list_forms", arguments: {} });
  ensureOk("list_forms", forms);
  const responses = await client.callTool({ name: "get_form_responses", arguments: { form_id: formId } });
  ensureOk("get_form_responses", responses);
  console.log("✓ Form create/list/read tools work");

  console.log(`\nDeployment verified: ${baseUrl}/mcp`);
} finally {
  try {
    if (formId) {
      const response = await fetch(`https://pagey.site/api/forms/${formId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok || response.status === 204) console.log("✓ Deleted the smoke-test form");
      else console.warn(`Could not delete smoke-test form ${formId} (HTTP ${response.status})`);
    }
  } catch {
    console.warn(`Could not delete smoke-test form ${formId ?? ""}`.trim());
  }
  await client.close().catch(() => undefined);
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
  const deadline = Date.now() + 25_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "follow", cache: "no-store" });
      lastStatus = response.status;
      if (response.status === 200) {
        const html = await response.text();
        if (html.includes(needle)) return;
      }
    } catch {
      // Retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error(`Live site ${url} did not serve the expected content (last HTTP ${lastStatus})`);
}
