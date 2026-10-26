// cli.js — winch subcommands over the shared store. Every subcommand that
// needs the DB resolves it through paths.js: WINCH_DB, else
// ~/.winch/store.sqlite.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createStore } from "./store.js";
import { readyTasks } from "./ready-queue.js";
import { tick } from "./watcher.js";
import { shipRelease } from "./release.js";
import { collectPRs, applyMergeOutcomes } from "./merges.js";
import { startMcpServer } from "./mcp.js";
import { startEventServer } from "./events-ws.js";
import { declaredFromEnv } from "./identity.js";
import { resolveDbPath } from "./paths.js";

export { resolveDbPath };

// stdout is the data channel for every subcommand; diagnostics go to stderr.
function openStore(explicitConfig) {
  return createStore({ dbPath: resolveDbPath(), config: explicitConfig });
}

// --config takes a JSON object or a path to a JSON file, the way --harness
// takes a name: explicit object > WINCH_* env > code defaults. Malformed
// config fails the command, naming the key.
function loadConfig(values) {
  if (!values.config) return undefined;
  const raw = String(values.config);
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(readFileSync(raw, "utf8"));
    } catch (err) {
      fail(`winch: --config is neither JSON nor a readable file: ${err?.message ?? err}`);
    }
  }
}

const USAGE = `usage: winch <command>

  serve --mcp stdio|http [--port N] [--host H]
                                      serve the backlog tools over MCP stdio or Streamable HTTP
                                      (stdio harness from WINCH_HARNESS env only; agent+session stamped per call)
  serve --ws --port N [--host H]         stream store events over WebSocket
  watch                                  one watcher tick (JSON manifest on stdout)
  resume <taskId> [--actor <name>]       resolve a human gate: blocked → todo
  next                                   list the current ready queue
  release-epic --epic <id> [--task ID] [--version V] [--base B]
  merge-detect [--dry-run]               apply merged/closed PR outcomes
  webhook set --harness H --url U [--bearer B] [--timeout-ms N]
                                           register a harness callback URL (checked first at claim)
  webhook list                             list registered callback URLs
  webhook remove --harness H              drop a registered callback URL
  webhook test --harness H                POST a test ping to the harness target
  agent set --agent A --capabilities a,b  declare what an agent can do (assignment matches on this)
  agent list                              list declared agents and capabilities
  agent remove --agent A                  drop a declaration`;

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return;

    case "watch": {
      const { values } = parseArgs({
        args: rest,
        options: { config: { type: "string" } },
        allowPositionals: true,
      });
      const store = openStore(loadConfig(values));
      try {
        console.log(JSON.stringify(tick(store)));
      } finally {
        store.close();
      }
      return;
    }

    case "resume": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { actor: { type: "string" } },
        allowPositionals: true,
      });
      const taskId = positionals[0];
      if (!taskId) fail("usage: winch resume <taskId> [--actor <name>]");
      const store = openStore();
      try {
        const r = store.task.resumeGate({ id: taskId, actor: values.actor ?? "operator" });
        if (!r) fail(`not resumable: ${taskId}`, 1);
        console.log(JSON.stringify(r, null, 2));
      } finally {
        store.close();
      }
      return;
    }

    case "next": {
      const store = openStore();
      try {
        const rows = readyTasks(store, { limit: 20 });
        console.log(JSON.stringify(
          rows.map((r) => ({ taskId: r.task.id, title: r.task.title, assigned: r.task.assigned, story: r.story.id, epic: r.epic.id })),
          null, 2
        ));
      } finally {
        store.close();
      }
      return;
    }

    case "release-epic": {
      const { values } = parseArgs({
        args: rest,
        options: {
          epic: { type: "string" },
          task: { type: "string" },
          version: { type: "string" },
          base: { type: "string" },
        },
      });
      if (!values.epic) fail("usage: winch release-epic --epic <id> [--task ID] [--version V] [--base B]");
      const store = openStore();
      try {
        const r = shipRelease(store, {
          epicId: values.epic,
          taskId: values.task ?? null,
          version: values.version ?? null,
          base: values.base ?? "main",
        });
        console.log(r.prUrl);
      } catch (e) {
        fail(`release-epic failed: ${e.message ?? e}`, 1);
      } finally {
        store.close();
      }
      return;
    }

    case "merge-detect": {
      const { values } = parseArgs({ args: rest, options: { "dry-run": { type: "boolean" } } });
      const store = openStore();
      try {
        const prs = collectPRs({ exec: execFileSync });
        const summary = applyMergeOutcomes(store, prs, { exec: execFileSync, dryRun: !!values["dry-run"] });
        console.log(JSON.stringify(summary, null, 2));
      } catch (e) {
        fail(`merge-detect failed: ${e.message ?? e}`, 1);
      } finally {
        store.close();
      }
      return;
    }

    case "serve": {
      let values;
      try {
        ({ values } = parseArgs({
          args: rest,
          options: {
            ws: { type: "boolean" },
            mcp: { type: "string" },
            port: { type: "string" },
            host: { type: "string" },
            config: { type: "string" },
          },
        }));
      } catch (err) {
        // --harness (or any unknown flag) on serve means the caller is still
        // on the legacy `mcp --harness` surface: stdio harness is env-only.
        if (/Unknown option|ERR_PARSE_ARGS_UNKNOWN_OPTION/.test(String(err?.message ?? err))) {
          fail("winch serve --mcp takes no --harness flag: set WINCH_HARNESS in the environment.");
        }
        throw err;
      }
      if (values.mcp !== undefined && values.mcp !== "stdio" && values.mcp !== "http") {
        fail(`winch: --mcp must be stdio or http, got ${JSON.stringify(values.mcp)}`);
      }
      const modes = ["ws", "mcp"].filter((k) => values[k]);
      if (modes.length !== 1) {
        fail("usage: winch serve (--ws | --mcp stdio|http) [--port N] [--host H] [--config JSON|PATH]");
      }
      const store = openStore(loadConfig(values));
      const logger = {
        info: (...a) => console.error(...a),
        warn: (...a) => console.error(...a),
        error: (...a) => console.error(...a),
      };
      // localhost-only unless asked: streams and tool traffic carry raw
      // store rows, so they stay behind loopback or a bearer-checked proxy.
      const host = values.host ?? "127.0.0.1";
      const port = values.port ? Number(values.port) : undefined;
      if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
        fail(`winch: --port must be 1-65535, got ${JSON.stringify(values.port)}`);
      }
      if (values.mcp === "stdio") {
        // Harness is env-only here by design: the spawner owns identity.
        let base;
        try {
          base = declaredFromEnv();
        } catch (err) {
          fail(String(err?.message ?? err));
        }
        try {
          await startMcpServer({ store, base, logger });
        } catch (err) {
          fail(String(err?.message ?? err));
        }
        return;
      }
      if (values.mcp === "http") {
        try {
          const { startMcpHttpServer } = await import("./mcp-http.js");
          await startMcpHttpServer({ store, port, host, logger });
        } catch (err) {
          fail(String(err?.message ?? err));
        }
        return;
      }
      await startEventServer({ store, port, host, logger });
      logger.info(`winch: events on ws://${host}:${port ?? store.config.wsPort} (append-only; subscribers track their own state)`);
      return;
    }

    case "agent": {
      const [sub, ...subRest] = rest;
      if (!["set", "list", "remove"].includes(sub)) fail("usage: winch agent (set|list|remove) …");
      const store = openStore();
      try {
        if (sub === "list") {
          console.log(JSON.stringify(store.agent.list(), null, 2));
          return;
        }
        const { values } = parseArgs({ args: subRest, options: { agent: { type: "string" }, capabilities: { type: "string" } } });
        const agent = values.agent?.trim();
        if (!agent) fail(`winch agent ${sub} requires --agent <id>`);
        if (sub === "remove") {
          if (!store.agent.remove({ agent })) fail(`no declaration for agent: ${agent}`, 1);
          console.log(JSON.stringify({ removed: agent }));
          return;
        }
        const capabilities = String(values.capabilities ?? "")
          .split(",").map((c) => c.trim()).filter(Boolean);
        console.log(JSON.stringify(store.agent.set({ agent, capabilities }), null, 2));
        return;
      } finally {
        store.close();
      }
    }

    case "webhook": {
      const [sub, ...subRest] = rest;
      if (!["set", "list", "remove", "test"].includes(sub)) {
        fail("usage: winch webhook (set|list|remove|test) …");
      }
      if (sub === "list") {
        const store = openStore();
        try {
          console.log(JSON.stringify(store.webhook.list(), null, 2));
        } finally {
          store.close();
        }
        return;
      }
      const { values } = parseArgs({
        args: subRest,
        options: {
          harness: { type: "string" },
          url: { type: "string" },
          bearer: { type: "string" },
          "timeout-ms": { type: "string" },
        },
      });
      const harness = values.harness;
      if (!harness || !harness.trim()) fail(`winch webhook ${sub} requires --harness <name>`);
      const store = openStore();
      try {
        if (sub === "remove") {
          const removed = store.webhook.remove({ harness });
          if (!removed) fail(`no webhook registered for harness: ${harness}`, 1);
          console.log(JSON.stringify({ removed: harness }));
          return;
        }
        if (sub === "set") {
          if (!values.url) fail("winch webhook set requires --url <http(s)://…>");
          const timeoutMs = values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : null;
          if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
            fail(`winch: --timeout-ms must be a positive integer, got ${JSON.stringify(values["timeout-ms"])}`);
          }
          try {
            const row = store.webhook.upsert({ harness, url: values.url, bearer: values.bearer ?? null, timeoutMs });
            console.log(JSON.stringify({ ...row, bearer: row.bearer ? "<set>" : null }, null, 2));
          } catch (err) {
            fail(String(err?.message ?? err), 1);
          }
          return;
        }
        // test: resolve exactly like a claim would (registry → env map → single)
        // and POST a test ping. The plugin answers {ok:true,test:true}.
        const { webhookConfig } = await import("./claim-webhook.js");
        const hook = webhookConfig(store.config, harness, store.webhook.get(harness));
        if (!hook) fail(`no webhook target for harness: ${harness} (register one or set WINCH_CLAIM_WEBHOOK_URL)`, 1);
        const headers = { "content-type": "application/json" };
        if (hook.bearer) headers.authorization = `Bearer ${hook.bearer}`;
        try {
          const res = await fetch(hook.url, {
            method: "POST",
            headers,
            body: JSON.stringify({ event: "webhook.test", at: Date.now(), harness }),
            signal: AbortSignal.timeout(hook.timeoutMs),
          });
          const text = await res.text();
          console.log(JSON.stringify({ ok: res.ok, status: res.status, body: text.slice(0, 500) }, null, 2));
          if (!res.ok) process.exitCode = 1;
        } catch (err) {
          fail(`webhook test failed: ${err?.message ?? err}`, 1);
        }
        return;
      } finally {
        store.close();
      }
    }

    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}
