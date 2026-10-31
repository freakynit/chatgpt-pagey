import { loadConfig } from "./config.js";
import { Store } from "./auth/store.js";
import { createApp } from "./http/app.js";
import { Logger } from "./util/logger.js";

const config = loadConfig();
const log = new Logger(config.logLevel);
const store = new Store(config.dataDir);
const app = createApp(config, store, log);

const server = app.listen(config.port, config.host, () => {
  log.info("Pagey MCP server listening", {
    url: `${config.publicBaseUrl.origin}/mcp`,
    address: `${config.host}:${config.port}`,
  });
});

server.on("error", (error) => {
  log.error("HTTP server error", { message: error.message });
  store.close();
  process.exitCode = 1;
});

const cleanupTimer = setInterval(() => {
  try {
    store.cleanup();
  } catch (error) {
    log.warn("OAuth cleanup failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Shutting down", { signal });
  clearInterval(cleanupTimer);
  const force = setTimeout(() => {
    log.warn("Forcing shutdown");
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
