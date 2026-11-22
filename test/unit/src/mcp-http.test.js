import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createStore } from "../../../src/store/index.js";
import { startMcpHttpServer } from "../../../src/mcp-http.js";

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
});

let dir, store, srv, bearer;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "winch-mcp-http-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  bearer = process.env.WINCH_BEARER;
  process.env.WINCH_BEARER = "test-bearer";
});

afterEach(async () => {
  if (srv) await srv.close();
  srv = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
  if (bearer === undefined) delete process.env.WINCH_BEARER;
  else process.env.WINCH_BEARER = bearer;
});

async function start() {
  srv = await startMcpHttpServer({ store, port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${srv.port}`;
}

function post(base, { headers = {}, body = INIT } = {}) {
  const url = new URL(`${base}/mcp`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const auth = () => ({ authorization: "Bearer test-bearer", "x-winch-harness": "test" });

test("mcp-http rejects a non-local Host before auth", async () => {
  const base = await start();
  assert.equal(await post(base, { headers: { host: "evil.example.com" } }), 403);
  assert.equal(await post(base, { headers: { host: "evil.example.com", ...auth() } }), 403);
});

test("mcp-http rejects a non-local Origin", async () => {
  const base = await start();
  assert.equal(await post(base, { headers: { origin: "http://evil.example.com", ...auth() } }), 403);
  assert.equal(await post(base, { headers: { origin: "http://8.8.8.8", ...auth() } }), 403);
});

test("mcp-http accepts loopback Host and Origin", async () => {
  const base = await start();
  const port = new URL(base).port;
  assert.equal(await post(base, { headers: auth() }), 200);
  assert.equal(await post(base, { headers: { host: `localhost:${port}`, ...auth() } }), 200);
  assert.equal(await post(base, { headers: { origin: `http://127.0.0.1:${port}`, ...auth() } }), 200);
});
