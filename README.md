# winch

Winch is a pull-based delivery backlog — epic → story → task with a
dependency DAG — served as an MCP server. A planner protocols a demand with
`backlog_plan`, which writes the spec into the records (task description,
story acceptance, capability tags) rather than into a message, and directs
work with `backlog_assign`. A worker is woken with a task id, reads the
record with `backlog_task_get`, then claims it with `backlog_claim` (one
named task) or `backlog_next` (highest-priority ready task for *this* agent)
— both atomic CAS under a per-identity lease, so a race loser simply loses.
Work reports through `backlog_update` / `backlog_done`; human gates open
with `backlog_block` and resolve with `backlog_resume`. A release/merge loop
(`release-epic`, `merge-detect`) carries backlog markers through branch →
PR → merge, and `serve --ws` streams every store event for subscribers to
handle however they want — including waking the assignee when a task lands.

Winch is harness-agnostic: the server contains no harness-specific code. The
adapters under `plugins/` are optional and installed per harness; the MCP
contract itself is the only integration surface.

## Install / run

- Node 22+. Runtime deps are the MCP SDK, its `zod` peer, Drizzle ORM, and
  `better-sqlite3` (a native module; prebuilt binaries cover common platforms,
  otherwise a C++ toolchain is needed).
- Install the published package (GitHub Packages) — no git clone needed:
  ```sh
  # one line in ~/.npmrc (auth: a token with read:packages, e.g. GITHUB_TOKEN)
  echo '@igorjpimenta:registry=https://npm.pkg.github.com' >> ~/.npmrc
  npm install -g @igorjpimenta/winch   # stable (`latest` tag)
  # npm install -g @igorjpimenta/winch@beta   # pre-release channel
  winch serve --mcp stdio   # binary is `winch`; harness via WINCH_HARNESS
  ```
- From source instead: `npm install`, then `./bin/winch.js <command>` — or
  `npm link` for a global `winch`.
- `winch serve --mcp stdio` serves the backlog tools over MCP stdio
  (stdout is JSON-RPC; logs go to stderr; harness from `WINCH_HARNESS` env).
- `WINCH_BEARER=… winch serve --mcp http --port N` serves the same tools
  over Streamable HTTP for local harnesses sharing one daemon.

## CLI

| command                                                         | what it does                                            |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `serve --mcp stdio`                                             | serve the backlog tools over MCP stdio (env-only harness) |
| `serve --mcp http --port N [--host H]`                          | serve the same tools over Streamable HTTP (shared daemon) |
| `watch`                                                         | one watcher tick (JSON manifest on stdout)              |
| `resume <taskId> [--actor <name>]`                              | resolve a human gate: blocked → todo                    |
| `next`                                                          | list the current ready queue                            |
| `release-epic --epic <id> [--task ID] [--version V] [--base B]` | release notes + branch/PR with backlog markers          |
| `merge-detect [--dry-run]`                                      | apply merged/closed PR outcomes                         |
| `webhook set --harness H --url U [--bearer B]`                  | register a harness callback URL (checked first at claim) |
| `webhook list` / `webhook remove --harness H`                    | inspect / drop registered callback URLs                 |
| `webhook test --harness H`                                      | POST a test ping to the harness target                  |
| `serve --ws --port N [--host H]`                               | stream store events over WebSocket                      |

## Deploy (any server)

Winch is cloud-agnostic: the portable build is the container below — plain
Node + a SQLite file on a volume, no cloud SDKs or provider APIs. Run it on
any VPS, compose host or cluster with one replica (SQLite has one writer).

```sh
docker build -t winch .
docker run -d --name winch --restart unless-stopped \
  -e WINCH_BEARER="$(openssl rand -base64 32)" \
  -v winch-data:/data -p 38292:38292 winch
# or: WINCH_BEARER=... docker compose up -d --build
```

- `GET /health` is unauthenticated (load-balancer / `HEALTHCHECK` probe);
  everything else needs `Authorization: Bearer <WINCH_BEARER>`.
- Terminate TLS in front (Caddy / Traefik / ingress); point harnesses at
  `https://<host>/mcp` with the bearer + `X-Winch-Harness` headers — the
  same contract as `serve --mcp http` locally. LangGraph needs no local
  spawn: `streamablehttp_client` straight to the URL.
- The volume holds `WINCH_DB` (`/data/store.sqlite` in the image); back it
  up like any stateful file. Never bake `WINCH_BEARER` into the image.
- The lease sweeper is a tick, not a daemon: run `watch` on a host cron (or
  a second one-shot service) against the same DB file when co-located; skip
  it when the DB lives elsewhere — claims still self-heal on next tick.

## Events stream

`winch serve --ws [--port N] [--host H]` (default port 38291, localhost-only
unless `--host` says otherwise) tails the events table and broadcasts every
new row to all connected clients as JSON text frames:

- `{"type":"welcome","lastEventId":N}` on connect, then
  `{"type":"history","events":[...]}` (newest 200), then
- `{"type":"event","kind":"task.completed","id":N,"at":T,"task":{id,title,
  story,epic,acceptance,artifacts,assignee},"actor":"…","note":"…"}` per
  insert, in id order.

Kinds on the wire come in three families — `task.*` for task lifecycle,
`gate.*` for gate lifecycle, `release.*` for shipment — each declared by its
producer at write time and stored on the row's `kind` column (`openGate`,
`resumeGate`, merge-detect's dissolve and ship paths; human gates open
exclusively through `openGate`). A shipped row asserts a tag exists:
merge-detect tags first and writes nothing on tag failure. The emitter feeds
the stored kind straight through; otherwise a row maps by transition
structure alone. Notes never classify anything: they are free text and can
change, so pre-kind rows keep exactly the meanings they streamed with — an
append-only log keeps its history.
The closed catalog lives in `src/events-ws.js` and is named here by family
only, so the two cannot drift. History and live
rows share one envelope shape.

Delivery-dynamics notes the wire will not tell you: heartbeats renew the
claim lease (only silence gets swept); an unmerged close dissolves its gate
(late approvals answer `gate_dissolved`); starvation lives in the watcher
manifest (`deferred` list, per-task `idleMs`), not the stream; a disputed
completion is a new ticket linked by dep edge with a `supersedes: TASK-x`
note, never a rewrite of history.

Typed kinds and embedded task context land in follow-up work; this surface
streams rows verbatim.

The server never interprets a row — a gate opening is just another event,
and reminders, digests and dashboards are subscriber code. Reconnect replays
history, so a missed frame costs a re-read, never a lost event. No auth in
process: keep the loopback bind, or put a bearer-checked reverse proxy in
front. Plain HTTP hits get 404.

## Store

DB path resolution: `WINCH_DB` → `~/.winch/store.sqlite`. The store is
winch's, not the launching harness's.

Schema lives in `src/schema.js` as Drizzle tables. `npm run db:generate`
turns schema changes into SQL in `.migrations/`; `src/db.js` applies pending
migrations on open, and `npm run db:migrate` does the same explicitly for a
deploy. The files are plain SQL and may be edited before they are applied for
data backfills, triggers, or renames; an applied migration is a snapshot, so
append a new one instead of editing it. `npx drizzle-kit generate --custom
--name=<name>` creates an empty SQL file for a hand-written data migration.

Concurrency note: concurrent access to the sqlite file — server, watcher and
CLI processes at once — is safe under WAL mode, and
`test/store.race.test.js`
races 4 real OS processes with independent handles through one claim to prove
the CAS transaction boundary under WAL contention.

## Identity

Every claim is keyed `harness:agent:session`. The **harness is
declared at construction** — `winch serve --mcp stdio` will not start
without `WINCH_HARNESS` in the environment, because an unnamed server
cannot attribute anything.
The agent and session of each call are stamped per call by the calling
harness's companion plugin (`_meta.winch`), which overwrites unconditionally,
so model-supplied meta cannot impersonate an agent. A call whose agent or
session is unstamped fails loudly instead of minting a default key. The contract, the
per-dimension table and the harness adapter setup snippets
live in [plugins/README.md](plugins/README.md).

## Configuration

Tuning knobs are declared the way the harness is — and none of them is
required. Precedence per knob: per-call `_meta.winch.config` > constructor
`{ config }` (`createStore`, `--config JSON|PATH` on `mcp`/`serve`/`watch`)
> `WINCH_*` env > code default. An undeclared server behaves exactly like
the old hardcoded one. Malformed values refuse (bad key named) at startup
for construction config, per call for meta overlay; unknown explicit keys
refuse as likely typos, unknown meta keys are ignored for forward compat.

| knob | env | default |
|---|---|---|
| Claim lease | `WINCH_LEASE_SECONDS` | 1800 (30 min) |
| Sweeper max attempts | `WINCH_MAX_ATTEMPTS` | 3 |
| Gate-wait thresholds | `WINCH_GATE_WAIT_LEVELS` (`"24h,72h"`, `ms\|s\|m\|h\|d` suffixes) | 24h / 72h |
| WS port / history / poll | `WINCH_WS_PORT` / `WINCH_WS_HISTORY_LIMIT` / `WINCH_WS_INTERVAL_MS` | 38291 / 200 / 1000 ms |
| MCP HTTP port | `WINCH_MCP_HTTP_PORT` | 38292 |
| Claim webhook URL / bearer / timeout | `WINCH_CLAIM_WEBHOOK_URL` / `WINCH_CLAIM_WEBHOOK_BEARER` / `WINCH_CLAIM_WEBHOOK_TIMEOUT_MS` | unset / unset / 3000 ms |
| Claim webhooks per harness (map) | `WINCH_CLAIM_WEBHOOKS` (`{"openclaw":{"url":"…","bearer":"…"}}`) | `{}` (falls back to single URL) |
| Wake routing cap | `WINCH_MAX_ACTIVE_PER_AGENT` | 2 |
| Scan limits (tick / candidates / blocked list) | `WINCH_SCAN_LIMIT` / `WINCH_CANDIDATES` / `WINCH_BLOCKED_LIMIT` | 50 / 5 / 20 |
| Dep cycle-check cap | `WINCH_DFS_NODES` | 500 nodes |
| Note caps (progress / result / reason / artifact) | `WINCH_NOTE_{PROGRESS,RESULT,REASON,ARTIFACT}_LIMIT` | 2000 / 4000 / 1000 / 500 |
| Artifacts per done | `WINCH_MAX_ARTIFACTS` | 50 |
