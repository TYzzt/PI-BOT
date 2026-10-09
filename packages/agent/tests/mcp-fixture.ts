import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["echo", "disabled", "slow"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "slow")
    await new Promise((r) => setTimeout(r, 2000));
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          text: request.params.arguments?.text,
          key: process.env.FIXTURE_SECRET,
          leak: process.env.T_AGNET_DATABASE_URL ?? null,
        }),
      },
    ],
  };
});
await server.connect(new StdioServerTransport());
