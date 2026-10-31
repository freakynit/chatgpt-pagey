import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version.js";
import { INSTRUCTIONS } from "./instructions.js";
import { registerTools, type ToolContext } from "./tools.js";

export function createPageyMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: "pagey-site",
      version: VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );
  registerTools(server, ctx);
  return server;
}
