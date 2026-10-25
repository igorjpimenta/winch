// mcp-http.js — shared Streamable HTTP MCP server (local daemon).
// Same tools + same identity contract as stdio (src/mcp.js), different door:
// one TCP socket, many harnesses as HTTP clients instead of one pipe per spawn.
//
// Auth: loopback bind + `Authorization: Bearer <WINCH_BEARER>` checked before
// any tool runs (WINCH_BEARER required; missing/empty refuses to start).
// Identity: `X-Winch-Harness: <name>` declares the harness per session and
// must be a usable layer; agent+session still arrive per call via _meta.winch
// (openclaw) or stamped args (opencode) — identical to stdio resolution.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4-mini";
import { createToolHandlers } from "./tools.js";
import { resolveIdentity, identitySessionKey, assertDeclaration } from "./identity.js";
import { toolErrorResult } from "./mcp.js";

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
  shape.winch_agent = z.optional(z.string());
  shape.winch_session = z.optional(z.string());
  shape._meta = z.optional(z.unknown());
  return shape;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function startMcpHttpServer({ store, port = null, host = "127.0.0.1", logger } = {}) {
  const bearer = process.env.WINCH_BEARER;
  if (!bearer || bearer.trim() === "") {
    throw new Error("winch: serve --mcp-http refuses without WINCH_BEARER (local, but with auth). Set a bearer token in the environment.");
  }
  const cfg = store.config ?? {};
  const listenPort = port ?? cfg.mcpHttpPort ?? 38292;
  const sessions = new Map();

  async function sessionFor(req, base) {
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string" && sessions.has(sid)) return sessions.get(sid);
    const { TOOL_DEFS, handle } = createToolHandlers(store, logger);
    const server = new McpServer({ name: "winch", version: "0.1.0" });
    for (const def of TOOL_DEFS) {
      server.registerTool(
        def.name,
        { description: def.description, inputSchema: z.object(shapeFromJson(def.inputSchema)) },
        async (args, extra) => {
          try {
            const identity = resolveIdentity({ meta: extra?._meta, args, base });
            logger?.info?.(`winch: ${def.name} from ${identitySessionKey(identity)}`);
            const res = await handle(def.name, args, identity, extra?._meta);
            return { content: res.content };
          } catch (err) {
            return toolErrorResult(err);
          }
        }
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, { server, transport }),
    });
    transport.onclose = () => {
      for (const [id, entry] of sessions) {
        if (entry.transport === transport) sessions.delete(id);
      }
    };
    await server.connect(transport);
    return { server, transport };
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("winch mcp-http: POST /mcp only\n");
        return;
      }
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${bearer}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized: bad or missing bearer" }));
        return;
      }
      const harness = req.headers["x-winch-harness"];
      let base;
      try {
        base = assertDeclaration({ harness: Array.isArray(harness) ? harness[0] : harness });
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing or reserved X-Winch-Harness" }));
        return;
      }
      const { transport } = await sessionFor(req, base);
      let body;
      if (req.method === "POST") body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logger?.warn?.(`winch: mcp-http request failed: ${err?.message ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(listenPort, host, () => {
      logger?.info?.(`winch: mcp-http on http://${host}:${httpServer.address().port}/mcp (Streamable HTTP; bearer + X-Winch-Harness)`);
      resolve({
        port: httpServer.address().port,
        host,
        close: () => new Promise((res) => httpServer.close(() => res())),
      });
    });
  });
}
