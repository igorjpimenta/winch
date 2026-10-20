# winch companion plugins — the identity contract

The winch server keys every budget and claim to three dimensions
(`src/identity.js`), resolved per request, each tagged with where it came
from. Resolution order is **meta > env > fallback**:

| dimension | who writes (meta channel)  | env channel        | fallback value    | who reads                                   |
| --------- | -------------------------- | ------------------ | ----------------- | ------------------------------------------- |
| harness   | companion plugin: `_meta.winch.harness` | `WINCH_HARNESS` | `unknown`  | winch server: logs, `harness:agent:session` budget key |
| agent     | plugin: ctx `agentId`      | `WINCH_AGENT_ID`   | `default` | winch server: claim attribution, per-agent caps |
| session   | plugin: ctx `sessionKey`/`runId` | `WINCH_SESSION` | `instance:<pid>` | winch server: budget/claim key |

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

1. Install the plugin: copy or symlink `plugins/openclaw/winch-meta/` →
   `~/.openclaw/extensions/winch-meta/`.
2. In `~/.openclaw/openclaw.json`, add the MCP server (mirrors the `gbrain`
   entry) and the plugin id (mirrors the `browser-lease` line in
   `plugins.allow`):

```json
"mcp": {
  "servers": {
    "winch": { "command": "winch", "args": ["mcp"] }
  }
},
"plugins": {
  "allow": [ "...existing entries...", "winch-meta" ]
}
```

Calls arrive as `mcp__winch__backlog_next` etc.; the hook filters on the
`winch` substring and stamps meta from `ctx.sessionKey` → `ctx.runId` (the
same field chain browser-lease's `ownerFor` resolves from). No resolvable
session or agent → the hook returns `undefined` and the call degrades to env.

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
      "command": ["winch", "mcp"],
      "env": {
        "WINCH_HARNESS": "opencode",
        "WINCH_AGENT_ID": "<agent>"
      }
    }
  },
  "plugin": [
    "file:///opt/homebrew/lib/node_modules/@igorjpimenta/doppler-harness/dist/loader.js",
    "file:///opt/homebrew/lib/node_modules/@igorjpimenta/doppler-harness/dist/doppler.js",
    "file:///Users/herculano/.dev/winch/plugins/opencode/winch-meta.js"
  ]
}
```

Session: the env block is process-scoped (one MCP server per opencode
instance), so session falls to the server-side `instance:<pid>` fallback.
Per-agent separation works today via `WINCH_AGENT_ID`; per-session separation
needs a future meta-capable hook.

## generic MCP clients

```
claude mcp add winch -- winch mcp
```

No plugin: set `WINCH_HARNESS` / `WINCH_AGENT_ID` / `WINCH_SESSION` in the
server's environment if you care about identity, otherwise the instance
fallback applies.
