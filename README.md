# winch

Winch is a pull-based delivery backlog — epic → story → task with a
dependency DAG — served as an MCP server. Agents claim work with atomic CAS
claims under per-identity leases (`backlog_next` claims the highest-priority
ready task for *this* agent, or silently loses the race to a concurrent
claim), report through `backlog_update` / `backlog_done`, open human gates
with `backlog_block` and resolve them with `backlog_resume`; a release/merge
loop (`release-epic`, `merge-detect`) carries backlog markers through branch →
PR → merge, `metrics` / `rollup` report per-hop failures and dispatch
fractions, and `serve --ws` streams every store event for subscribers to
handle however they want.

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
| `watch`                                                       | one watcher tick (JSON manifest on stdout)              |
| `resume <taskId> [--actor <name>]`                            | resolve a human gate: blocked → todo                    |
| `next`                                                        | list the current ready queue                            |
| `metrics [--json] [--window-days N]`                          | per-hop failure report                                  |
| `rollup [--json]`                                             | dispatch fraction + epic token rollup                   |
| `release-epic --epic <id> [--task ID] [--version V] [--base B]` | release notes + branch/PR with backlog markers        |
| `merge-detect [--dry-run]`                                    | apply merged/closed PR outcomes                         |
| `check-slugs [--config <path>]`                               | live-verify registered model slugs                      |
| `serve --ws --port N [--host H]`                             | stream store events over WebSocket                      |

## Events stream

`winch serve --ws [--port N] [--host H]` (default port 38291, localhost-only
unless `--host` says otherwise) tails the events table and broadcasts every
new row to all connected clients as JSON text frames:

- `{"type":"welcome","lastEventId":N}` on connect, then
  `{"type":"history","events":[...]}` (newest 200), then
- `{"type":"event","kind":"task.completed","id":N,"at":T,"task":{id,title,
  story,epic,acceptance,artifacts,assignee},"actor":"…","note":"…"}` per
  insert, in id order.

Kinds wired so far: `task.*` family, `gate.opened` / `gate.resolved`,
and `budget.exhausted` (note-prefix rule ahead of the generic progressed
branch — the latch writes a real row). `release.shipped` still has no store
signal and is not emitted. History and live rows share one envelope shape.

Typed kinds and embedded task context land in follow-up work; this surface
streams rows verbatim.

The server never interprets a row — a gate opening is just another event,
and reminders, digests and dashboards are subscriber code. Reconnect replays
history, so a missed frame costs a re-read, never a lost event. No auth in
process: keep the loopback bind, or put a bearer-checked reverse proxy in
front. Plain HTTP hits get 404.

## Store

DB path resolution: `WINCH_DB` → `BACKLOG_DB_PATH` →
`~/.openclaw/backlog/store.sqlite`.

Migration note: concurrent access to the sqlite file — server, watcher and
CLI processes at once — is safe under WAL mode, and
`test/store.race.test.js`
races 4 real OS processes with independent handles through one claim to prove
the CAS transaction boundary under WAL contention.

## Identity

Every claim and budget is keyed `harness:agent:session`. The **harness is
declared at construction** — `winch mcp` will not start without `--harness`
(or `WINCH_HARNESS`), because an unnamed server cannot attribute anything.
The agent and session of each call are stamped per call by the calling
harness's companion plugin (`_meta.winch`), which overwrites unconditionally,
so model-supplied meta cannot impersonate an agent. A call whose agent or
session is unstamped fails loudly instead of minting a default key. The contract, the
per-dimension table and the openclaw/opencode/generic-client setup snippets
live in [plugins/README.md](plugins/README.md).
