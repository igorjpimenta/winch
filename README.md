# winch

Winch is a pull-based delivery backlog — epic → story → task with a
dependency DAG — served as an MCP server. Agents claim work with atomic CAS
claims under per-identity leases (`backlog_next` claims the highest-priority
ready task for *this* agent, or silently loses the race to a concurrent
claim), report through `backlog_update` / `backlog_done`, open human gates
with `backlog_block` (the watcher pings and reminds over Telegram) and
resolve them with `backlog_resume`; a release/merge loop (`release-epic`,
`merge-detect`) carries backlog markers through branch → PR → merge, and
`metrics` / `rollup` report per-hop failures and dispatch fractions.
Extraction provenance: lifted from the openclaw `backlog-system` extension
(oc-config), PRs #208–#227, test suite carried 67 → 69 tests as of
extraction.

## Install / run

- Node 22+ (uses `node:sqlite`; runtime deps are the MCP SDK and its `zod`
  peer only).
- `npm install`, then `./bin/winch.js <command>` — or `npm link` for a global
  `winch`.
- `winch mcp` serves the five backlog tools over MCP stdio (stdout is
  JSON-RPC; logs go to stderr).

## CLI

| command                                                       | what it does                                            |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `mcp`                                                         | serve the backlog tools over MCP stdio                  |
| `watch [--notify]`                                            | one watcher tick (JSON manifest on stdout)              |
| `resume <taskId> [--actor <name>]`                            | resolve a human gate: blocked → todo                    |
| `next`                                                        | list the current ready queue                            |
| `metrics [--json] [--window-days N]`                          | per-hop failure report                                  |
| `rollup [--json]`                                             | dispatch fraction + epic token rollup                   |
| `release-epic --epic <id> [--task ID] [--version V] [--base B]` | release notes + branch/PR with backlog markers        |
| `merge-detect [--dry-run]`                                    | apply merged/closed PR outcomes                         |
| `check-slugs [--config <path>]`                               | live-verify registered model slugs                      |
| `gate-notified <taskId>`                                      | record that the operator was pinged                     |

## Store

DB path resolution: `WINCH_DB` → `BACKLOG_DB_PATH` →
`~/.openclaw/backlog/store.sqlite`.

Migration note: sharing the sqlite file with an already-installed openclaw
backlog-system plugin is safe — WAL mode, and `test/store.race.test.js`
races 4 real OS processes with independent handles through one claim to prove
the CAS transaction boundary under WAL contention.

## Identity

Every claim and budget is keyed `harness:agent:session`, resolved per request
as `_meta.winch` (companion plugin) > `WINCH_*` env > `instance:<pid>`
fallback. Companion plugins overwrite `_meta.winch` unconditionally, so
model-supplied meta cannot impersonate an agent. The contract, the
per-dimension table and the openclaw/opencode/generic-client setup snippets
live in [plugins/README.md](plugins/README.md).
