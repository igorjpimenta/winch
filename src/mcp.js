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
import { resolveIdentity, identitySessionKey, assertDeclaration } from "./identity.js";

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
  // Identity is a transport concern, not a tool-domain one — like _meta, it
  // rides every call without belonging to any tool's vocabulary. Declared
  // here (optional, so schemas stay backward compatible) rather than in each
  // TOOL_DEF: companions that can only mutate args (e.g. opencode's hook)
  // stamp these, and resolveIdentity reads them when _meta is unreachable.
  // Sound only over stdio, where the spawner is the sole peer; a companion
  // overwrites them unconditionally, so model-supplied values never survive.
  shape.winch_agent = z.optional(z.string());
  shape.winch_session = z.optional(z.string());
  return shape;
}

/**
 * Unexpected failures — anything handle() throws, including a poisoned
 * caller identity — become tool-error results. Domain rejections keep their
 * own content; the call fails, the server survives the request.
 */
export function toolErrorResult(err) {
  const message = `winch: tool failed: ${String(err?.message ?? err)}`;
  // keep stdio clean: diagnostics would corrupt the JSON-RPC stream
  if (process.env.WINCH_MCP_DEBUG) {
    console.error(message);
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export async function startMcpServer({ store, base, logger }) {
  // Identity is refused, never defaulted, at both layers: an undeclared
  // server will not start, and an unstamped, unusable, or mismatched call
  // will not run. No path mints a key the trail cannot attribute — failure
  // happens at the boundary, never as poison downstream.
  const declared = assertDeclaration(base);
  const { TOOL_DEFS, handle } = createToolHandlers(store, logger);
  const server = new McpServer({ name: "winch", version: "0.1.0" });

  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: z.object(shapeFromJson(def.inputSchema)) },
      async (args, extra) => {
        try {
          const identity = resolveIdentity({ meta: extra?._meta, args, base: declared });
          logger?.info?.(`winch: ${def.name} from ${identitySessionKey(identity)}`);
          // Per-call config overlay rides the same trusted meta channel as
          // agent/session; malformed knobs refuse the call, never the server.
          const res = await handle(def.name, args, identity, extra?._meta);
          return { content: res.content };
        } catch (err) {
          return toolErrorResult(err);
        }
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger?.info?.("winch: MCP server connected on stdio");
  return server;
}
