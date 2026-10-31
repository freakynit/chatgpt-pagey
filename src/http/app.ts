import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { Config } from "../config.js";
import type { Store } from "../auth/store.js";
import { createPageyClient, decryptPageyToken, installOAuth } from "../auth/oauth.js";
import { createPageyMcpServer } from "../mcp/server.js";
import type { Logger } from "../util/logger.js";
import { RateLimiter } from "../util/rate-limit.js";
import { VERSION } from "../version.js";
import { renderLandingPage, renderMessagePage, renderPrivacyPage, renderTermsPage } from "./pages.js";

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function createApp(config: Config, store: Store, log: Logger): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  // Health checks often use the pod IP as the Host header, so answer this
  // before host validation.
  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", service: "pagey-chatgpt", version: VERSION });
  });

  const allowedHosts = [...new Set([config.publicBaseUrl.hostname, "localhost", "127.0.0.1", "[::1]"])];
  app.use(hostHeaderValidation(allowedHosts));

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", CSP);
    if (config.publicBaseUrl.protocol === "https:") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  const oauth = installOAuth(app, {
    config,
    store,
    log,
    fetchUser: (token) => createPageyClient(token, config).me(),
  });

  const mcpLimiter = new RateLimiter(120, 60_000);

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(renderLandingPage({ baseUrl: config.publicBaseUrl.origin, repoUrl: config.repoUrl }));
  });

  app.get("/privacy", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(renderPrivacyPage({ repoUrl: config.repoUrl }));
  });

  app.get("/terms", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(renderTermsPage({ repoUrl: config.repoUrl }));
  });

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /mcp\nDisallow: /authorize\nDisallow: /token\nDisallow: /register\nAllow: /\n");
  });

  app.get("/favicon.ico", (_req, res) => {
    res.status(204).end();
  });

  app.options("/mcp", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
  });

  app.post(
    "/mcp",
    oauth.requireAuth,
    express.json({ limit: config.mcpBodyLimitBytes }),
    async (req: Request, res: Response) => {
      const connectionId = req.auth?.extra?.["connectionId"];
      if (typeof connectionId !== "string") {
        res.status(401).json(rpcError(-32001, "Missing Pagey connection"));
        return;
      }
      const connection = store.getConnection(connectionId);
      if (!connection) {
        res.status(401).json(rpcError(-32001, "The Pagey connection no longer exists"));
        return;
      }

      const limit = mcpLimiter.check(connectionId);
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        res.status(429).json(rpcError(-32000, "Too many Pagey requests. Try again shortly."));
        return;
      }

      let pageyToken: string;
      try {
        pageyToken = decryptPageyToken(connection, oauth.tokenKey);
      } catch {
        log.warn("Stored Pagey token could not be decrypted", { connectionId });
        res
          .status(401)
          .setHeader(
            "WWW-Authenticate",
            `Bearer error="invalid_token", error_description="Reconnect Pagey", resource_metadata="${config.publicBaseUrl.origin}/.well-known/oauth-protected-resource"`,
          )
          .json(rpcError(-32001, "Reconnect the Pagey plugin to continue"));
        return;
      }

      const server = createPageyMcpServer({
        config,
        store,
        connection,
        pagey: createPageyClient(pageyToken, config),
        log,
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        log.error("MCP transport failed", { error: error instanceof Error ? error.name : "unknown" });
        if (!res.headersSent) {
          res.status(500).json(rpcError(-32603, "Internal MCP error"));
        }
      }
    },
  );

  const methodNotAllowed = (req: Request, res: Response): void => {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json(rpcError(-32000, `Method ${req.method} is not allowed on this stateless MCP endpoint`));
  };
  app.get("/mcp", oauth.requireAuth, methodNotAllowed);
  app.delete("/mcp", oauth.requireAuth, methodNotAllowed);

  app.use((req, res) => {
    if (req.path.startsWith("/mcp") || req.accepts(["json", "html"]) === "json") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res
      .status(404)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(renderMessagePage("Not found", "That page does not exist.", { link: { href: "/", label: "Go home" } }));
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const type = isRecord(error) && typeof error["type"] === "string" ? error["type"] : "";
    if (type === "entity.too.large") {
      if (req.path === "/mcp") res.status(413).json(rpcError(-32000, "Request body is too large"));
      else res.status(413).json({ error: "Request body is too large" });
      return;
    }
    if (error instanceof SyntaxError || type === "entity.parse.failed") {
      if (req.path === "/mcp") res.status(400).json(rpcError(-32700, "Parse error"));
      else res.status(400).json({ error: "Invalid request body" });
      return;
    }
    if (req.path === "/mcp") {
      log.error("MCP request failed", { error: error instanceof Error ? error.name : "unknown" });
      res.status(500).json(rpcError(-32603, "Internal server error"));
      return;
    }
    log.error("HTTP request failed", { error: error instanceof Error ? error.name : "unknown" });
    if (req.accepts(["html", "json"]) === "html") {
      res
        .status(500)
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .send(renderMessagePage("Something went wrong", "The request could not be completed. Try again."));
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function rpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
