// mcp.js — stdio MCP server exposing the backlog tools. stdout is the
// JSON-RPC channel: every log line goes to stderr, and nothing else may be
// written to stdout.
//
// Request `_meta` surfaces on the handler's second argument (`extra._meta`,
// the original request's params._meta — see the SDK's RequestHandlerExtra).
// `extra._meta.winch` is the trusted companion-plugin channel; models cannot
// forge it because the plugin overwrites it unconditionally.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4-mini";
import { createToolHandlers } from "./tools.js";
import { resolveIdentity, identitySessionKey } from "./identity.js";

// JSON Schema → zod raw shape for the subset the tool defs use (string,
// boolean, string arrays, nested objects, string enums). zod is the MCP
// SDK's required peer dependency, not a direct winch dependency.
function fieldFromJson(schema) {
  if (!schema || typeof schema !== "object") return z.unknown();
  if (schema.enum && Array.isArray(schema.enum)) return z.enum(schema.enum);
  if (schema.type === "string") return z.string();
  if (schema.type === "boolean") return z.boolean();
  if (schema.type === "array") return z.array(fieldFromJson(schema.items));
  if (schema.type === "object") return z.object(shapeFromJson(schema));
  return z.unknown();
}

function shapeFromJson(schema) {
  const shape = {};
  const required = new Set(schema.required ?? []);
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    const field = fieldFromJson(sub);
    shape[key] = required.has(key) ? field : z.optional(field);
  }
  return shape;
}

export async function startMcpServer({ store, logger }) {
  const { TOOL_DEFS, handle } = createToolHandlers(store, logger);
  const server = new McpServer({ name: "winch", version: "0.1.0" });

  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: z.object(shapeFromJson(def.inputSchema)) },
      async (args, extra) => {
        const identity = resolveIdentity({ meta: extra?._meta });
        logger?.info?.(`winch: ${def.name} from ${identitySessionKey(identity)}`);
        const res = await handle(def.name, args, identity);
        return { content: res.content };
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger?.info?.("winch: MCP server connected on stdio");
  return server;
}
