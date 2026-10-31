#!/usr/bin/env node
// Local stdio smoke test. Verifies the stdio entry point and the Pagey token
// without creating or changing any site.
//
//   PAGEY_API_TOKEN=... npm run smoke

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.PAGEY_API_TOKEN?.trim();
if (!token) {
  console.error("PAGEY_API_TOKEN is required.");
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "pagey-smoke-"));
const env = Object.fromEntries(
  Object.entries({
    ...process.env,
    PAGEY_API_TOKEN: token,
    DATA_DIR: dataDir,
    LOG_TO_STDERR: "1",
    LOG_LEVEL: "warn",
  }).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/stdio.ts"],
  cwd: process.cwd(),
  env,
  stderr: "inherit",
});

const client = new Client({ name: "pagey-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({ name: "whoami", arguments: {} });
  const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const text = content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  if (result.isError) throw new Error(text);
  console.log(text);
  console.log("✓ stdio MCP server and Pagey token are working");
} finally {
  await client.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
