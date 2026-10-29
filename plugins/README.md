# winch companion plugins — the identity contract

The winch server keys every claim to three dimensions
(`src/identity.js`), and only one of them is declared: the **harness**,
named at construction (`--harness` / `WINCH_HARNESS`). The **agent** and
**session** of each call arrive with the call itself — the calling harness's
companion plugin stamps them in its `before_tool_call` hook, the way lineage
attributes per-call cost to an agent and a session instead of a configured
default. Unstamped agent/session fail the call; nothing defaults, ever.

| dimension | construction                     | per-call source                          | who reads                                   |
| --------- | -------------------------------- | ---------------------------------------- | ------------------------------------------- |
| harness   | `WINCH_HARNESS` env (**required**, stdio) / `X-Winch-Harness` header (HTTP) | `_meta.winch.harness` if stamped (never overrides a matching declaration) | winch server: logs, `harness:agent:session` claim key |
| agent     | — (never declared)               | plugin: ctx `agentId`                    | winch server: claim attribution, per-agent caps |
| session   | — (never declared)               | plugin: ctx `sessionKey`/`runId`         | winch server: claim key |

**Anti-impersonation:** the openclaw plugin's `before_tool_call` hook runs
before MCP dispatch and returns a full replacement of `event.params` with
`_meta.winch` set **unconditionally** on every winch tool call — a model that
supplies its own `_meta.winch` has it overwritten before the request reaches
the server. On opencode the meta channel is unreachable (mechanics below), so
identity is the operator-set env on the MCP server entry — process-scoped
configuration the model cannot alter per call, so the same property holds by
construction.

## openclaw

Setup verified against the existing extension wiring: every loaded extension
id is listed in `openclaw.json` → `plugins.allow` (e.g. `browser-lease`), and
extensions are discovered from `~/.openclaw/extensions/<id>/` — openclaw.json
carries no explicit extensions path; the browser-lease extension lives at
`~/.openclaw/extensions/browser-lease/` with its own `openclaw.plugin.json`.

1. Install the plugin package (its own release line, and it pulls
   `@igorjpimenta/winch` as a dependency): `openclaw plugins install
   @igorjpimenta/winch-openclaw`. From a checkout instead: copy or symlink
   `plugins/openclaw/winch/` into `~/.openclaw/extensions/winch/`.
   Then set `webhookBearer` (any secret) in the extension config —
   `webhookPublicBaseUrl` (e.g. `http://127.0.0.1:18789`) if the gateway
   port isn't detectable. On boot the plugin registers its own route in
   winch (`winch webhook set` + `test`) and logs the result — no manual
   step unless it warns you with the exact command. Opt out with
   `webhookAutoregister: false`. Multi-gateway setups: set
   `webhookHarness` per gateway to match its winch MCP entry's
   `WINCH_HARNESS`.
2. In `~/.openclaw/openclaw.json`, add the MCP server (mirrors the `gbrain`
   entry) and the plugin id (mirrors the `browser-lease` line in
   `plugins.allow`):

```json
"mcp": {
  "servers": {
    "winch": {
      "command": "winch",
      "args": ["serve", "--mcp", "stdio"],
      "env": { "WINCH_HARNESS": "openclaw" }
    }
  }
},
"plugins": {
  "allow": [ "...existing entries...", "winch" ]
}
```

Calls arrive as `mcp__winch__backlog_claim` etc.; the hook filters on the
`winch` substring and stamps meta from `ctx.sessionKey` → `ctx.sessionId` →
`ctx.runId` (mirroring the HookContext the host guarantees for bundled MCP
calls since v2026.5.16-beta.7; oldest compatible stable is v2026.5.18,
declared in `package.json` as `openclaw.install.minHostVersion`, enforced by
install and registry loading). No resolvable session or agent → the hook
returns `undefined`; the call reaches the server unstamped and is refused
(there is no env fallback).

## Assignment dispatch (wake on routing)

An assigned task is inert until someone starts the assignee's session, and a
worker must never receive a hand-written brief: the record is the spec.

The plugin does this itself: it follows `winch serve --ws` (config
`dispatchWsUrl`, default `ws://127.0.0.1:38291`), and for each routable row
starts a one-shot agent session whose message is just the item id — `TASK-…` to
claim, `STORY-…` to break down, `EPIC-…` to review. The session is started
through the gateway's own CLI entry (`agent --session-key
agent:<agent>:winch:<id>`), because the host only lets bundled plugins schedule
turns in-process. Config: `dispatchEnabled`
(default true), `dispatchPlanner` (fallback: atlas), `dispatchStatePath`
(reviewed epics across restarts).

Routing, one row per decision:

- `task.assigned` → the assignee (never the planner itself)
- `story.assigned` → the story owner, to append its tasks
- `task.appended` → the epic's creator, to route the new work
- a close (`done`/`cancelled`) → every assigned task the envelope reports as
  `unblocked`, so dependents start without a scheduler
- `epic.completed` → the epic's creator, to review the delivery

Two more rows matter to the dispatcher:

- `story.assigned` — a story handed to one agent to break down. Wake that
  agent with the story id; it reads the story and appends tasks, which then
  arrive as `task.appended` rows for the planner to route.
- `task.appended` — work recorded after the plan (`backlog_append`) lands
  unassigned. Wake the planner so it routes the task; a dispatcher can wait a
  few seconds first and skip it if the appending turn already assigned.
- `story.completed` — written when a story's last task closes; usually just
  bookkeeping for dashboards.
- `epic.completed` — exactly one row per epic, written when its last story
  closes (each story closes when its last task does). Wake `epics.created_by`
  with the epic id; the planner calls `backlog_get`, reviews the delivered
  results and artifacts, and either appends follow-up tasks (which reopens the
  epic) or reports it done. Act on each epic once, not on every replay.

Dispatch is event-driven, never polled: `serve --ws` replays backlog history
on connect (`{"type":"history"}`), so a restarted gateway catches up without a
timer. A task wake is suppressed for 35 minutes and an epic review happens
once per epic (remembered in `dispatchStatePath`); the claim lease remains the
real guard against double work.

## Claim webhook (wake on attribution)

Polling `backlog_claim` leaves an idle agent waiting for its next heartbeat.
Instead, winch can push the handoff the moment a claim lands and the plugin
opens a **fresh session** for the task:

1. On the plugin: set `webhookBearer` (any secret) in the extension config —
   `~/.openclaw/openclaw.json` → the extension's config. The route
   `POST /api/winch/claimed` stays disarmed (503) until set.
2. On winch: register the callback URL. Persistent (survives restarts,
   checked first at claim time) — `winch webhook set --harness openclaw
   --url http://<gateway-host>:<port>/api/winch/claimed --bearer <same
   secret>` — then verify with `winch webhook test --harness openclaw`
   (the plugin answers `{ok:true,test:true}` without waking anyone).
   Ephemeral alternative: `WINCH_CLAIM_WEBHOOK_URL` (+ `_BEARER`) for one
   harness, or `WINCH_CLAIM_WEBHOOKS='{"openclaw":{"url":"…","bearer":"…"}}'`
   per harness (or the `--config` equivalents). Nothing registered anywhere
   = no-op; claims behave exactly as before.
3. On claim, winch POSTs `{event:"task.claimed", task, session, handoff}`
   (see `src/claim-webhook.js`); the plugin verifies the bearer, then
   `scheduleSessionTurn`s a one-shot turn (`deleteAfterRun`, tag
   `winch-claim`) in session `winch-claim-<TASK-ID>` carrying the receiver
   prompt, and injects a pointer into the claiming session. If the fresh
   session fails, the turn falls back to the claiming session; if scheduling
   is unavailable, the claim parks in a pending queue (4h TTL) drained by
   the heartbeat hook — the agent's next natural wake carries the handoff.
   Delivery never fails the claim (bounded 3s timeout, failures are warnings).

## opencode

opencode's `tool.execute.before` hook can mutate the outgoing call's `args`
but cannot reach request `_meta` (its MCP path sends only name + arguments).
winch therefore declares `winch_agent` / `winch_session` as optional schema
slots (`src/mcp.js`) and reads them as a whole pair (`src/identity.js`); the
companion stamps them unconditionally, so a model-supplied pair never
survives. This channel is sound over stdio, where the spawner is the sole
peer — use a stdio MCP entry, not a shared HTTP daemon.

`@igorjpimenta/winch-opencode` is that companion. Install it and add the MCP
entry:

```jsonc
{
  "mcp": {
    "winch": {
      "type": "local",
      "command": ["winch", "serve", "--mcp", "stdio"],
      "environment": { "WINCH_HARNESS": "opencode" }
    }
  },
  "plugin": ["@igorjpimenta/winch-opencode"]
}
```

The hook learns the agent from `chat.message` / `chat.params` per session and
falls back to `WINCH_AGENT` when the host does not surface it. Agent and
session are then stamped on every winch call, so claims are attributed to the
real caller instead of being refused.

## Remote servers: URL + credentials

Winch itself authenticates nothing on stdio — it trusts the OS user, and that
is the whole auth model in-process. A hosted winch (`winch serve --mcp http`,
or any stdio→network bridge you run in front of a stdio server) authenticates
at the transport: reverse proxy, tailnet identity, or the bearer check in
front of (or built into) the HTTP daemon. Keep credentials and
identity apart in your head: a token proves *which deployment* may call; the
declared harness/agent/session says *whose work* this is. Keep credentials and
identity apart in your head: a token proves *which deployment* may call; the
declared harness/agent/session says *whose work* this is.

| client | local (stdio) | remote (URL) | credentials live in |
| --- | --- | --- | --- |
| openclaw | `mcp.servers.winch = {command, args, env}` | same object plus `url`, `transport: "sse" \| "streamable-http"`, `headers` | the `headers` map, e.g. `Authorization` |
| opencode | `"type": "local", command, environment` | `"type": "remote", url, headers` | the `headers` map |
| langgraph | stdio entry in `mcpServers` | SSE/HTTP transport entry per its adapter | the adapter's header/auth config |
| claude | `claude mcp add winch --env WINCH_HARNESS=generic -- winch serve --mcp stdio` | `claude mcp add --transport http <name> <url> -H "Authorization: Bearer …"` | the `-H` flags, stored in its config |

## generic MCP clients


```
claude mcp add winch --env WINCH_HARNESS=generic -- winch serve --mcp stdio
```

No plugin: declare the harness in the environment and stamp agent/session
per call yourself, or the server refuses:

```
WINCH_HARNESS=generic winch serve --mcp stdio
```

### langgraph

A LangGraph deployment is one more declared consumer; declare the graph's
identity as the floor the server keys everything to:

A LangGraph deployment declares the one thing it can — its own harness —
and stamps agent/session per call from its own wiring (thread id and node
name make natural values):

```json
{
  "mcpServers": {
    "winch": {
      "command": "winch",
      "args": ["serve", "--mcp", "stdio"],
      "env": { "WINCH_HARNESS": "langgraph" }
    }
  }
}
```

Env works identically (`WINCH_HARNESS=langgraph`). Without per-call stamps
the calls fail loudly — which is the correct signal that the graph side of
the identity contract is not wired yet.
