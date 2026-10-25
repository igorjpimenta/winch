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

1. Install the plugin from the published package (no git clone):
   `cp -r "$(npm root -g)/@igorjpimenta/winch/plugins/openclaw/winch-meta" \
    ~/.openclaw/extensions/winch-meta/` (or symlink it).
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
  "allow": [ "...existing entries...", "winch-meta" ]
}
```

Calls arrive as `mcp__winch__backlog_next` etc.; the hook filters on the
`winch` substring and stamps meta from `ctx.sessionKey` → `ctx.sessionId` →
`ctx.runId` (mirroring the HookContext the host guarantees for bundled MCP
calls since v2026.5.16-beta.7; oldest compatible stable is v2026.5.18,
declared in `package.json` as `openclaw.install.minHostVersion`, enforced by
install and registry loading). No resolvable session or agent → the hook
returns `undefined`; the call reaches the server unstamped and is refused
(there is no env fallback).

## opencode

Why env, not meta: opencode's `tool.execute.before` can mutate the outgoing
call's `args` (the plugin types declare `output: { args: any }`, return
`Promise<void>` — mutation is the only channel), but opencode's MCP path
builds the request as `callTool({ name, arguments: args })`: params carry
only name + arguments, there is **no `params._meta` slot**, and every MCP
input schema is forced `additionalProperties: false`, so an `args._meta`
injection is stripped or rejected before the wire. The winch server reads
`extra._meta` (= request `params._meta`), unreachable from this hook on the
checked opencode surface (1.18.32 plugin types and binary). So
`plugins/opencode/winch-meta.js` is a registered no-op that documents the
constraint in place and keeps a hook point for an opencode version that grows
request-level meta mutation.

`~/.config/opencode/opencode.jsonc` — MCP entry plus plugin line, mirroring
the existing `file://` entries in that file's `plugin` array:

```jsonc
{
  "mcp": {
    "winch": {
      "type": "local",
      "command": ["winch", "serve", "--mcp", "stdio"],
      "env": {
        "WINCH_HARNESS": "opencode"
      }
    }
  },
  "plugin": [
    "file:///opt/homebrew/lib/node_modules/@igorjpimenta/doppler-harness/dist/loader.js",
    "file:///opt/homebrew/lib/node_modules/@igorjpimenta/doppler-harness/dist/doppler.js",
    "file://<npm-root-g>/@igorjpimenta/winch/plugins/opencode/winch-meta.js"
  ]
}
```

`<npm-root-g>` is `npm root -g` (where `npm install -g @igorjpimenta/winch`
lands) — the plugin loads from the published package, never a git checkout.

Agent/session on opencode: opencode's hooks cannot carry per-call identity,
so winch refuses unstamped calls there. Per-agent, per-session support needs
a future meta-capable hook; until then identity-bearing calls are refused.

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
