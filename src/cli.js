// cli.js — winch subcommands over the shared store. Every subcommand that
// needs the DB resolves it the same way: WINCH_DB, else BACKLOG_DB_PATH,
// else the default store under the user's home.

import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createStore } from "./store.js";
import { readyTasks } from "./ready-queue.js";
import { tick } from "./watcher.js";
import { shipRelease } from "./release.js";
import { collectPRs, applyMergeOutcomes } from "./merges.js";
import { failureReport, formatFailureReport } from "./metrics.js";
import { dispatchFraction, epicTokenRollup } from "./rollup.js";
import { startMcpServer } from "./mcp.js";
import { startEventServer, DEFAULT_WS_PORT } from "./events-ws.js";
import { assertDeclaration } from "./identity.js";

export function resolveDbPath() {
  return process.env.WINCH_DB || process.env.BACKLOG_DB_PATH || path.join(os.homedir(), ".openclaw", "backlog", "store.sqlite");
}

// stdout is the data channel for every subcommand; diagnostics go to stderr.
function openStore() {
  return createStore({ dbPath: resolveDbPath() });
}

const USAGE = `usage: winch <command>

  mcp --harness H serve the backlog tools over MCP stdio
                                     (identity: harness declared here, agent+session stamped per call)
  watch                                  one watcher tick (JSON manifest on stdout)
  resume <taskId> [--actor <name>]       resolve a human gate: blocked → todo
  next                                   list the current ready queue
  metrics [--json] [--window-days N]     per-hop failure report
  rollup [--json]                        dispatch fraction + epic token rollup
  release-epic --epic <id> [--task ID] [--version V] [--base B]
  merge-detect [--dry-run]               apply merged/closed PR outcomes
  check-slugs [--config <path>]          live-verify registered model slugs
  serve --ws --port N [--host H]         stream store events over WebSocket`;

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

    case "mcp": {
      const { values } = parseArgs({
        args: rest,
        options: {
          harness: { type: "string" },
        },
      });
      const store = openStore();
      const logger = {
        info: (...a) => console.error(...a),
        warn: (...a) => console.error(...a),
        error: (...a) => console.error(...a),
      };
      try {
        // harness from flag or env; agent/session arrive per call via the hook
        const base = assertDeclaration({
          harness: values.harness ?? process.env.WINCH_HARNESS,
        });
        await startMcpServer({ store, base, logger });
      } catch (err) {
        fail(String(err?.message ?? err));
      }
      return;
    }

    case "watch": {
      const store = openStore();
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

    case "metrics": {
      const { values } = parseArgs({
        args: rest,
        options: { json: { type: "boolean" }, "window-days": { type: "string" } },
      });
      const windowMs = values["window-days"] !== undefined ? Number(values["window-days"]) * 86_400_000 : undefined;
      const store = openStore();
      try {
        const report = failureReport(store, { windowMs });
        console.log(values.json ? JSON.stringify(report, null, 2) : formatFailureReport(report));
      } finally {
        store.close();
      }
      return;
    }

    case "rollup": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const store = openStore();
      try {
        const out = { dispatch: dispatchFraction(store), rollup: epicTokenRollup(store) };
        console.log(values.json ? JSON.stringify(out, null, 2) : JSON.stringify(out));
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

    case "check-slugs": {
      const script = path.join(import.meta.dirname, "check-slugs.mjs");
      execFileSync(process.execPath, [script, ...rest], { stdio: "inherit" });
      return;
    }

    case "serve": {
      const { values } = parseArgs({
        args: rest,
        options: {
          ws: { type: "boolean" },
          port: { type: "string" },
          host: { type: "string" },
        },
      });
      if (!values.ws) fail("usage: winch serve --ws [--port N] [--host H]");
      const store = openStore();
      const logger = {
        info: (...a) => console.error(...a),
        warn: (...a) => console.error(...a),
        error: (...a) => console.error(...a),
      };
      // localhost-only unless asked: the stream carries raw store rows,
      // so it stays behind the loopback interface or a bearer-checked proxy.
      const host = values.host ?? "127.0.0.1";
      const port = values.port ? Number(values.port) : DEFAULT_WS_PORT;
      await startEventServer({ store, port, host, logger });
      logger.info(`winch: events on ws://${host}:${port} (append-only; subscribers track their own state)`);
      return;
    }

    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}
