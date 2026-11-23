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
import { collectPRs, applyMergeOutcomes, closeHitlAndFreeParents, isHitlChild } from "./merges.js";
import { startMcpServer } from "./mcp.js";
import { startDispatchServer } from "./webhook/server.js";
import { declaredFromEnv } from "./identity.js";
import { HUMAN_AGENT } from "./reserved.js";
import { resolveDbPath } from "./paths.js";

export { resolveDbPath };

// stdout is the data channel for every subcommand; diagnostics go to stderr.
function openStore(explicitConfig) {
  return createStore({ dbPath: resolveDbPath(), config: explicitConfig, notifyDispatch: true });
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
  watch                                  one watcher tick (JSON manifest on stdout)
  resume <taskId> [--actor <name>]       resolve a human gate: blocked → ready
  next                                   list the current ready queue
  hitl [--status S]                      list the human-in-the-loop queue (PR/release/design children)
  resolve <taskId> [--note N]            human closes a HITL child; frees parked parents
  release-epic --epic <id> [--task ID] [--version V] [--base B]
  merge-detect [--dry-run]               apply merged/closed PR outcomes
  webhook serve [--port N] [--host H]     serve dispatch registration, recovery and the wake pump
  webhook bearer                           generate a dispatch bearer
  webhook register --topic T [--harness H] [--executor E] --url U [--id I] [--bearer B] [--timeout-ms N]
                                           register or replace a webhook subscription
  webhook list [--topic T] [--harness H]  list webhook subscriptions (bearer redacted)
  webhook deliveries [--status S] [--admission ID] [--consumer ID] [--limit N]
                                           list per-consumer delivery ledger rows
  webhook revoke [--topic T] --id I       remove a webhook subscription
  webhook test [--topic T] [--harness H] [--id I]
                                           POST a ping to webhook subscriptions`;

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
        // Human work lives in `winch hitl` — keep it out of the agent queue.
        const rows = readyTasks(store, { limit: 20 })
          .filter((r) => r.task.assignee_agent !== HUMAN_AGENT);
        console.log(JSON.stringify(
          rows.map((r) => ({ taskId: r.task.id, title: r.task.title, assigned: r.task.assignee_agent, story: r.story.id, epic: r.epic.id })),
          null, 2
        ));
      } finally {
        store.close();
      }
      return;
    }

    case "hitl": {
      const { values } = parseArgs({
        args: rest,
        options: { status: { type: "string" }, config: { type: "string" } },
        allowPositionals: true,
      });
      const store = openStore(loadConfig(values));
      try {
        const want = values.status ?? null;
        const rows = store.item.list({ kind: "task" })
          .filter((t) => isHitlChild(t))
          .filter((t) => (want ? t.status === want : t.status !== "done" && t.status !== "cancelled"))
          .map((t) => {
            const artifacts = store.artifact.listFor(t.id);
            const parents = store.dep.listIncoming(t.id)
              .map((e) => store.task.get(e.from_id))
              .filter(Boolean)
              .map((p) => ({ id: p.id, title: p.title, status: p.status }));
            // artifacts.uri is globally unique — a PR attached before spawn
            // sits on the parent; surface both so the reviewer finds the link.
            const parentUris = new Set(artifacts.map((a) => a.uri));
            for (const p of store.dep.listIncoming(t.id)) {
              for (const a of store.artifact.listFor(p.from_id)) {
                if (!parentUris.has(a.uri)) {
                  artifacts.push({ ...a, via: p.from_id });
                  parentUris.add(a.uri);
                }
              }
            }
            return {
              taskId: t.id,
              title: t.title,
              status: t.status,
              acceptance: t.acceptance,
              artifacts: artifacts.map((a) => ({ kind: a.kind, uri: a.uri, label: a.label, via: a.via })),
              parents,
            };
          });
        console.log(JSON.stringify(rows, null, 2));
      } finally {
        store.close();
      }
      return;
    }

    case "resolve": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { note: { type: "string" }, config: { type: "string" } },
        allowPositionals: true,
      });
      const taskId = positionals[0];
      if (!taskId) fail("usage: winch resolve <taskId> [--note <text>]");
      const store = openStore(loadConfig(values));
      try {
        const task = store.task.get(taskId);
        if (!task) fail(`winch resolve: not found: ${taskId}`);
        if (!isHitlChild(task)) {
          fail(`winch resolve: ${taskId} is not a HITL child (assignee ${task.assignee_agent ?? "none"}) — only human-assigned review children resolve here`);
        }
        if (task.status === "done" || task.status === "cancelled") {
          console.log(JSON.stringify({ ok: true, task: { id: task.id, status: task.status }, doneTasks: [], alreadyResolved: true }, null, 2));
          return;
        }
        const note = values.note ?? "resolved by operator";
        const out = closeHitlAndFreeParents(store, task.id, {
          actor: "operator",
          resultSummary: note,
          note: `hitl resolved: ${note}`,
        });
        console.log(JSON.stringify({
          ok: true,
          task: { id: task.id, status: store.task.get(task.id)?.status },
          doneTasks: out.doneTasks,
          freedParents: out.resumed,
        }, null, 2));
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
            mcp: { type: "string" },
            port: { type: "string" },
            host: { type: "string" },
            config: { type: "string" },
          },
        }));
      } catch {
        fail("usage: winch serve --mcp stdio|http [--port N] [--host H] [--config JSON|PATH]");
      }
      if (values.mcp !== undefined && values.mcp !== "stdio" && values.mcp !== "http") {
        fail(`winch: --mcp must be stdio or http, got ${JSON.stringify(values.mcp)}`);
      }
      if (values.mcp === undefined) {
        fail("usage: winch serve --mcp stdio|http [--port N] [--host H] [--config JSON|PATH]");
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
      return;
    }

    case "webhook": {
      const [sub, ...subRest] = rest;
      if (!["serve", "bearer", "register", "list", "deliveries", "revoke", "test"].includes(sub)) {
        fail("usage: winch webhook (serve|bearer|register|list|deliveries|revoke|test) …");
      }
      const { values } = parseArgs({
        args: subRest,
        options: {
          harness: { type: "string" },
          url: { type: "string" },
          bearer: { type: "string" },
          topic: { type: "string" },
          id: { type: "string" },
          executor: { type: "string" },
          "timeout-ms": { type: "string" },
          status: { type: "string" },
          admission: { type: "string" },
          consumer: { type: "string" },
          limit: { type: "string" },
          port: { type: "string" },
          host: { type: "string" },
          config: { type: "string" },
        },
      });
      if (sub === "bearer") {
        console.log(crypto.randomBytes(32).toString("hex"));
        return;
      }
      if (sub === "serve") {
        const port = values.port ? Number(values.port) : undefined;
        if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
          fail(`winch: --port must be 1-65535, got ${JSON.stringify(values.port)}`);
        }
        const store = openStore(loadConfig(values));
        const logger = {
          info: (...a) => console.error(...a),
          warn: (...a) => console.error(...a),
          error: (...a) => console.error(...a),
        };
        const host = values.host ?? "127.0.0.1";
        try {
          const srv = await startDispatchServer({ store, port, host, logger });
          logger.info(`winch: dispatch on http://${host}:${srv.port} (webhooks; queue pump; lease sweep)`);
        } catch (err) {
          store.close();
          fail(String(err?.message ?? err));
        }
        return;
      }
      const store = openStore(loadConfig(values));
      try {
        if (sub === "list") {
          console.log(JSON.stringify(store.webhook.list({
            topic: values.topic ?? null,
            harness: values.harness ?? null,
          }).map((r) => ({
            topic: r.topic,
            id: r.id,
            harness: r.harness,
            executorId: r.executorId,
            url: r.url,
            bearer: "<set>",
            timeoutMs: r.timeoutMs,
            lastSeenAt: r.lastSeenAt,
            instanceId: r.instanceId,
            generation: r.generation,
            state: r.state,
            failureCount: r.failureCount,
            disabledAt: r.disabledAt,
            leaseUntil: r.leaseUntil,
            managed: r.managed,
          })), null, 2));
          return;
        }
        if (sub === "deliveries") {
          const limit = values.limit !== undefined ? Number(values.limit) : null;
          if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
            fail(`winch: --limit must be a positive integer, got ${JSON.stringify(values.limit)}`);
          }
          const rows = store.delivery.list({
            admissionId: values.admission ?? null,
            consumerId: values.consumer ?? null,
            status: values.status ?? null,
            limit,
          });
          console.log(JSON.stringify({
            count: rows.length,
            rows: rows.map((r) => ({
              id: r.id,
              admissionId: r.admission_id,
              attemptNo: r.attempt_no,
              eventId: r.event_id,
              consumerId: r.consumer_id,
              status: r.status,
              attempts: r.attempts,
              nextAt: r.next_at,
              lastStatus: r.last_status,
              lastError: r.last_error,
              deliveredAt: r.delivered_at,
              deadAt: r.dead_at,
            })),
          }, null, 2));
          return;
        }
        if (sub === "register") {
          if (!values.url) fail("winch webhook register requires --url U");
          const topic = (values.topic ?? "dispatch").trim();
          if (!topic) fail("winch webhook register requires a non-empty --topic");
          if (topic === "dispatch" && !values.harness) {
            fail("winch webhook register --topic dispatch requires --harness H");
          }
          const timeoutMs = values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : null;
          if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
            fail(`winch: --timeout-ms must be a positive integer, got ${JSON.stringify(values["timeout-ms"])}`);
          }
          const envBearer = (process.env.WINCH_WEBHOOK_BEARER ?? "").trim();
          const generated = !values.bearer && !envBearer;
          const bearer = values.bearer || envBearer || crypto.randomBytes(32).toString("hex");
          const id = values.id ?? values.executor ?? manualExecutorId(values.url);
          const executorId = values.executor ?? (topic === "dispatch" ? id : null);
          const row = store.webhook.upsert({
            topic,
            id,
            harness: values.harness ?? null,
            executorId,
            url: values.url,
            bearer,
            timeoutMs,
            managed: false,
            fresh: true,
          });
          console.log(JSON.stringify({
            topic: row.topic,
            id: row.id,
            harness: row.harness,
            executorId: row.executorId,
            url: row.url,
            bearer: generated ? bearer : "<set>",
            timeoutMs: row.timeoutMs,
            lastSeenAt: row.lastSeenAt,
            instanceId: row.instanceId,
            generation: row.generation,
            state: row.state,
            failureCount: row.failureCount,
            managed: row.managed,
          }, null, 2));
          return;
        }
        if (sub === "revoke") {
          const topic = (values.topic ?? "dispatch").trim();
          const id = values.id ?? values.executor;
          if (!topic || !id) fail("winch webhook revoke requires --id E");
          const removed = store.webhook.remove({ topic, id });
          if (!removed) fail(`no webhook endpoint for ${topic}/${id}`, 1);
          console.log(JSON.stringify({ revoked: `${topic}/${id}` }));
          return;
        }
        const topic = (values.topic ?? "dispatch").trim();
        const id = values.id ?? values.executor;
        const rows = store.webhook.list({ topic, harness: values.harness ?? null })
          .filter((r) => !id || r.id === id);
        if (!rows.length) fail(`no webhook endpoint for ${topic}${id ? `/${id}` : ""}`, 1);
        const results = await Promise.all(rows.map(async (row) => {
          const timeoutMs = row.timeoutMs ?? store.config.webhookTimeoutMs ?? 3000;
          try {
            const res = await fetch(row.url, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${row.bearer}` },
              body: JSON.stringify({ type: "ping", topic: row.topic, id: row.id, harness: row.harness, executorId: row.executorId, at: Date.now() }),
              signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await res.text().catch(() => "");
            return { topic: row.topic, id: row.id, harness: row.harness, executorId: row.executorId, url: row.url, ok: res.ok, status: res.status, body: text.slice(0, 500) };
          } catch (err) {
            return { topic: row.topic, id: row.id, harness: row.harness, executorId: row.executorId, url: row.url, ok: false, status: 0, error: String(err?.message ?? err) };
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
