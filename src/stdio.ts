// Stdio entry point for local MCP clients and Secure MCP Tunnel testing.
// ChatGPT web uses the remote OAuth server in index.ts instead.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Store } from "./auth/store.js";
import { createPageyClient } from "./auth/oauth.js";
import { createPageyMcpServer } from "./mcp/server.js";
import { deriveKey, encryptToken } from "./util/crypto.js";
import { Logger } from "./util/logger.js";

async function main(): Promise<void> {
  const token = process.env.PAGEY_API_TOKEN?.trim();
  if (!token) {
    console.error("PAGEY_API_TOKEN is required for stdio mode.");
    console.error("Create a token at https://pagey.site/dashboard/api-tokens and set it in the environment.");
    process.exit(2);
  }

  process.env.LOG_TO_STDERR = "1";
  const config = loadConfig();
  const log = new Logger(config.logLevel, true);
  const store = new Store(config.dataDir);
  const pagey = createPageyClient(token, config);

  let user;
  try {
    user = await pagey.me();
  } catch (error) {
    console.error(`Pagey rejected the API token: ${error instanceof Error ? error.message : "unknown error"}`);
    store.close();
    process.exit(2);
  }

  const connectionId = store.upsertConnection({
    pageyUserId: user.id,
    pageyEmail: user.email,
    pageyTier: user.tier ?? null,
    tokenEnc: encryptToken(token, deriveKey(config.secret, "pagey-token")),
  });
  const connection = store.getConnection(connectionId);
  if (!connection) {
    console.error("Could not create the local Pagey connection.");
    store.close();
    process.exit(2);
  }

  const server = createPageyMcpServer({ config, store, connection, pagey, log });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Pagey MCP stdio server ready", { email: user.email });

  const close = (): void => {
    void server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
