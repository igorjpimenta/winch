// cli.js — winch subcommands over the shared store. Every subcommand that
// needs the DB resolves it through paths.js: WINCH_DB, else
// ~/.winch/store.sqlite.

import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createStore } from "./store.js";
import { readyTasks } from "./ready-queue.js";
import { tick } from "./watcher.js";
import { shipRelease } from "./release.js";
import { collectPRs, applyMergeOutcomes } from "./merges.js";
import { startMcpServer } from "./mcp.js";
import { startEventServer, DEFAULT_WS_PORT } from "./events-ws.js";
import { assertDeclaration } from "./identity.js";
import { resolveDbPath } from "./paths.js";

export { resolveDbPath };

// stdout is the data channel for every subcommand; diagnostics go to stderr.
async function openStore() {
  return createStore({ dbPath: resolveDbPath() });
}

const USAGE = `usage: winch <command>

  mcp --harness H serve the backlog tools over MCP stdio
                                     (identity: harness declared here, agent+session stamped per call)
  watch                                  one watcher tick (JSON manifest on stdout)
  resume <taskId> [--actor <name>]       resolve a human gate: blocked → todo
  next                                   list the current ready queue
  release-epic --epic <id> [--task ID] [--version V] [--base B]
  merge-detect [--dry-run]               apply merged/closed PR outcomes
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
      const store = await openStore();
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
      const store = await openStore();
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
      const store = await openStore();
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
      const store = await openStore();
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
      const store = await openStore();
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
      const store = await openStore();
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
      const { values } = parseArgs({
        args: rest,
        options: {
          ws: { type: "boolean" },
          port: { type: "string" },
          host: { type: "string" },
        },
      });
      if (!values.ws) fail("usage: winch serve --ws [--port N] [--host H]");
      const store = await openStore();
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
