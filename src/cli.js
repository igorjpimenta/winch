// cli.js — winch subcommands over the shared store. Every subcommand that
// needs the DB resolves it through paths.js: WINCH_DB, else
// ~/.winch/store.sqlite.

import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createStore } from "./store/index.js";
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
  resume <taskId> [--actor <name>]       resolve a human gate: blocked → ready
  next                                   list the current ready queue
  release-epic --epic <id> [--task ID] [--version V] [--base B]
  merge-detect [--dry-run]               apply merged/closed PR outcomes
  webhook bearer                           generate a dispatch bearer
  webhook register --harness H --url U [--id E] [--bearer B] [--timeout-ms N]
                                           register or replace a webhook endpoint
  webhook list [--harness H]              list webhook endpoints (bearer redacted)
  webhook revoke --harness H --id E       remove a webhook endpoint
  webhook test --harness H [--id E]       POST a ping to webhook endpoints`;

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function manualExecutorId(url) {
  return `manual-${crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 12)}`;
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
          rows.map((r) => ({ taskId: r.task.id, title: r.task.title, assigned: r.task.assignee_agent, story: r.story.id, epic: r.epic.id })),
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

    case "webhook": {
      const [sub, ...subRest] = rest;
      if (!["bearer", "register", "list", "revoke", "test"].includes(sub)) {
        fail("usage: winch webhook (bearer|register|list|revoke|test) …");
      }
      const { values } = parseArgs({
        args: subRest,
        options: {
          harness: { type: "string" },
          url: { type: "string" },
          bearer: { type: "string" },
          id: { type: "string" },
          executor: { type: "string" },
          "timeout-ms": { type: "string" },
          config: { type: "string" },
        },
      });
      if (sub === "bearer") {
        console.log(crypto.randomBytes(32).toString("hex"));
        return;
      }
      const store = openStore(loadConfig(values));
      try {
        if (sub === "list") {
          console.log(JSON.stringify(store.dispatch.list({ harness: values.harness ?? null }).map((r) => ({
            harness: r.harness,
            id: r.executorId,
            url: r.url,
            bearer: "<set>",
            timeoutMs: r.timeoutMs,
            lastSeenAt: r.lastSeenAt,
          })), null, 2));
          return;
        }
        if (sub === "register") {
          if (!values.harness || !values.url) fail("winch webhook register requires --harness H --url U");
          const timeoutMs = values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : null;
          if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
            fail(`winch: --timeout-ms must be a positive integer, got ${JSON.stringify(values["timeout-ms"])}`);
          }
          const envBearer = (process.env.WINCH_DISPATCH_BEARER ?? "").trim();
          const generated = !values.bearer && !envBearer;
          const bearer = values.bearer || envBearer || crypto.randomBytes(32).toString("hex");
          const executorId = values.id ?? values.executor ?? manualExecutorId(values.url);
          const row = store.dispatch.upsert({ harness: values.harness, executorId, url: values.url, bearer, timeoutMs });
          console.log(JSON.stringify({
            harness: row.harness,
            id: row.executorId,
            url: row.url,
            bearer: generated ? bearer : "<set>",
            timeoutMs: row.timeoutMs,
            lastSeenAt: row.lastSeenAt,
          }, null, 2));
          return;
        }
        if (sub === "revoke") {
          const id = values.id ?? values.executor;
          if (!values.harness || !id) fail("winch webhook revoke requires --harness H --id E");
          const removed = store.dispatch.remove({ harness: values.harness, executorId: id });
          if (!removed) fail(`no webhook endpoint for ${values.harness}/${id}`, 1);
          console.log(JSON.stringify({ revoked: `${values.harness}/${id}` }));
          return;
        }
        if (!values.harness) fail("winch webhook test requires --harness H");
        const id = values.id ?? values.executor;
        const rows = store.dispatch.list({ harness: values.harness })
          .filter((r) => !id || r.executorId === id);
        if (!rows.length) fail(`no webhook endpoint for ${values.harness}${id ? `/${id}` : ""}`, 1);
        const results = await Promise.all(rows.map(async (row) => {
          const timeoutMs = row.timeoutMs ?? store.config.dispatchWebhookTimeoutMs ?? 3000;
          try {
            const res = await fetch(row.url, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${row.bearer}` },
              body: JSON.stringify({ type: "ping", harness: row.harness, executorId: row.executorId, at: Date.now() }),
              signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await res.text().catch(() => "");
            return { harness: row.harness, id: row.executorId, url: row.url, ok: res.ok, status: res.status, body: text.slice(0, 500) };
          } catch (err) {
            return { harness: row.harness, id: row.executorId, url: row.url, ok: false, status: 0, error: String(err?.message ?? err) };
          }
        }));
        console.log(JSON.stringify(results, null, 2));
        if (results.some((r) => !r.ok)) process.exitCode = 1;
      } finally {
        store.close();
      }
      return;
    }

    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}
