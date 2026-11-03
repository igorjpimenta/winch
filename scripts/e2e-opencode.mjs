#!/usr/bin/env node
// e2e-opencode.mjs — opt-in roundtrip between a real OpenCode harness and a
// real winch MCP server. Not part of `npm test`: it needs a model, credentials,
// and a live server, so it is a check a person runs deliberately.
//
//   WINCH_E2E_MODEL=anthropic/claude-sonnet-4 node scripts/e2e-opencode.mjs
//   WINCH_E2E_MODEL=... node scripts/e2e-opencode.mjs --harness opencode2 --reload
//
// The claim under test is the one the plugin exists for: a winch call made by a
// session reaches the server with the session's own agent and session stamped,
// and the model's copy of those fields never survives. `--reload` adds one more:
// that a v2 server started without the MCP entry picks it up on a later turn of
// the same session.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../src/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.WINCH_E2E_MODEL;
const TIMEOUT_MS = Number(process.env.WINCH_E2E_TIMEOUT_MS ?? 240_000);
const args = process.argv.slice(2);
const harness = args.includes("--harness")
  ? args[args.indexOf("--harness") + 1]
  : "opencode";
const reload = args.includes("--reload");

if (!MODEL) {
  console.error("e2e-opencode: set WINCH_E2E_MODEL (provider/model) — refusing to guess one.");
  process.exit(2);
}
if (harness !== "opencode" && harness !== "opencode2") {
  console.error(`e2e-opencode: --harness must be opencode or opencode2, got ${JSON.stringify(harness)}`);
  process.exit(2);
}
if (reload && harness !== "opencode2") {
  console.error("e2e-opencode: --reload describes the v2 config reload; use --harness opencode2.");
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "winch-e2e-"));
const dataDir = path.join(root, "data");
const stateDir = path.join(root, "state");
const project = path.join(root, "project");
const cfgDir = path.join(root, "cfg", "opencode");
for (const dir of [cfgDir, dataDir, stateDir, project]) fs.mkdirSync(dir, { recursive: true });

// Credentials are the one thing a scratch data directory cannot invent. Copy
// the user's auth file when present; a missing one fails at the model call with
// a message about the provider, which is the honest outcome.
try {
  fs.copyFileSync(
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(dataDir, "auth.json"),
  );
} catch {
  // no credentials to copy
}

const bearer = `winch-e2e-${Math.random().toString(36).slice(2)}`;
const dbPath = path.join(root, "winch.sqlite");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function mcpEntry(port) {
  return {
    type: "remote",
    url: `http://127.0.0.1:${port}/mcp`,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "X-Winch-Harness": "opencode",
    },
    enabled: true,
  };
}

function writeConfig({ port, withMcp }) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: withMcp ? { winch: mcpEntry(port) } : {},
    permission: { bash: { "*": "allow" }, shell: { "*": "allow" } },
  };
  if (harness === "opencode") {
    config.plugin = [
      new URL("file://" + path.join(ROOT, "plugins", "opencode", "winch", "index.js")).href,
    ];
  } else {
    config.plugins = [path.join(ROOT, "plugins", "opencode", "winch")];
  }
  fs.writeFileSync(path.join(cfgDir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function seedTask() {
  const store = createStore({ dbPath });
  const epic = store.epic.create({ title: "e2e", status: "planned", priority: 50 });
  const story = store.story.create({ epicId: epic.id, title: "roundtrip" });
  const task = store.task.create({ storyId: story.id, title: "winch-e2e-marker", executionKind: "manual" });
  return task;
}

async function waitForServer(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "winch-e2e", version: "0" },
        } }),
      });
      if (res.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`winch MCP server did not answer on ${port}`);
}

function runHarness(prompt, { continueSession }) {
  const bin = harness === "opencode" ? "opencode" : "opencode2";
  const argv = ["run", "--auto", "--model", MODEL];
  if (continueSession) argv.push("--continue");
  if (harness === "opencode2") argv.push("--standalone");
  argv.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, {
      cwd: project,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "cfg") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`harness timed out after ${TIMEOUT_MS}ms\n${stderr.slice(-2000)}`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const prompt = (task) =>
  `Call the winch MCP server's backlog_get tool with the argument id set to "${task.id}", ` +
  `and reply with only the title it returns.`;

let server;
let cleaned = false;
let keepArtifacts = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { server?.kill("SIGTERM"); } catch { /* already gone */ }
  if (!keepArtifacts) fs.rmSync(root, { recursive: true, force: true });
}
process.on("exit", cleanup);

try {
  const port = await freePort();
  const task = seedTask();
  console.error(`e2e-opencode: seeded ${task.id}`);
  console.error(`e2e-opencode: winch MCP on ${port}`);
  server = spawn(process.execPath, [path.join(ROOT, "bin", "winch.js"), "serve", "--mcp", "http", "--port", String(port)], {
    env: { ...process.env, WINCH_DB: dbPath, WINCH_BEARER: bearer, WINCH_HARNESS: "opencode" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverLog = "";
  server.stderr.on("data", (chunk) => { serverLog += chunk; });
  await waitForServer(port);
  console.error("e2e-opencode: server ready");

  if (reload) {
    writeConfig({ port, withMcp: false });
    console.error("e2e-opencode: first turn (no MCP)");
    const first = await runHarness("Reply with the single word ready.", { continueSession: false });
    if (first.code !== 0) throw new Error(`first turn failed (${first.code})\n${first.stderr.slice(-2000)}`);
    writeConfig({ port, withMcp: true });
  } else {
    writeConfig({ port, withMcp: true });
  }

  console.error(reload ? "e2e-opencode: second turn (MCP added)" : "e2e-opencode: roundtrip turn");
  const result = await runHarness(prompt(task), { continueSession: reload });
  if (result.code !== 0) {
    throw new Error(`harness exited ${result.code}\n${result.stderr.slice(-3000)}`);
  }
  if (!result.stdout.toLowerCase().includes("winch-e2e-marker")) {
    throw new Error(`the model did not return the task title\nstdout:\n${result.stdout.slice(-2000)}\nwinch log:\n${serverLog.slice(-2000)}`);
  }
  if (/refused caller identity/.test(serverLog)) {
    throw new Error(`winch refused the call\n${serverLog.slice(-3000)}`);
  }
  if (!/winch: backlog_get from opencode:[^:]+:ses_/.test(serverLog)) {
    throw new Error(`no attributed backlog_get in the winch log\n${serverLog.slice(-3000)}`);
  }

  console.log("ok: winch roundtrip");
  console.log(`  harness: ${harness}${reload ? " (config reload between turns)" : ""}`);
  console.log(`  agent/session: ${/winch: backlog_get from (opencode:[^:\s]+:ses_\S+)/.exec(serverLog)?.[1] ?? "(see log)"}`);
  cleanup();
} catch (err) {
  keepArtifacts = true;
  console.error(`e2e-opencode: ${err?.message ?? err}`);
  console.error(`e2e-opencode: artifacts kept at ${root}`);
  process.exitCode = 1;
}
