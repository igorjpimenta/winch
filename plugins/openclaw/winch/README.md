# @igorjpimenta/winch-openclaw

OpenClaw companion for [winch](https://github.com/igorjpimenta/winch). Four jobs:

1. **Identity** — `before_tool_call` stamps `_meta.winch {harness, agent, session}`
   onto every winch MCP tool call, overwriting unconditionally so model-supplied
   meta cannot impersonate an agent.
2. **Wake executor** — in core dispatch mode it sends `hello` with an executor
   id + harness, accepts a wake offer, and starts the assigned agent on
   `wake_granted`. One gateway wins; the rest get `wake_taken`.
3. **Claim receiver** — the plugin-mode fallback: serves
   `POST /api/winch/claimed`, verifies the bearer, then opens a fresh one-shot
   session (`winch-claim-<TASK-ID>`) carrying the receiver prompt.
4. **Self-registration** — on boot, registers its own claim route in winch
   (`winch webhook set` + `test`) so the operator has nothing to wire by hand.
   Core dispatch never sends claim webhooks, so that route is inert there.

## Install

```sh
openclaw plugins install @igorjpimenta/winch-openclaw --accept-capabilities
```

The manifest declares `activation.onStartup`, so the plugin loads at gateway
boot (without it the host never calls `register()` and the route never
binds). The `--accept-capabilities` flag is required: the plugin registers
an HTTP route and a service.

The plugin depends on `@igorjpimenta/winch`, so npm resolves and pins the
server version alongside it. Self-registration invokes the same `winch` the
harness MCP entry spawns (`webhookWinchBin` → `WINCH_BIN` → `PATH`), so both
always operate on one store.

Then set the shared secret in the plugin config (`webhookBearer`), and
`webhookPublicBaseUrl` if the gateway port isn't detectable. The route stays
disarmed (503) until `webhookBearer` is set.

## Releases

Ships on its own line, independent of the core server:
`winch-openclaw-<semver>` tags publish `@igorjpimenta/winch-openclaw`
(stable → `latest`, prerelease → `beta`). Bump this package's `version` and
its `@igorjpimenta/winch` dependency floor together.

## Config

| key | default | meaning |
|---|---|---|
| `webhookBearer` | — | secret winch sends; must match `WINCH_CLAIM_WEBHOOK_BEARER` |
| `webhookPublicBaseUrl` | `http://127.0.0.1:<gateway.port>` | address winch can reach |
| `webhookHarness` | `openclaw` | harness name registered in winch (must match `WINCH_HARNESS`) |
| `webhookAutoregister` | `true` | self-register the route on boot |
| `webhookWinchBin` | `WINCH_BIN` or `winch` | binary used for self-registration |
| `dispatchEnabled` | `true` | accept wake offers / route plugin-mode events |
| `dispatchWsUrl` | `ws://127.0.0.1:38291` | winch event stream |
| `dispatchHarness` | `webhookHarness` or `openclaw` | harness sent in the executor hello |
| `dispatchPlanner` | `atlas` | planner skipped by plugin-mode routing |
| `dispatchStatePath` | `~/.openclaw/state/winch-plugin-dispatch.json` | reviewed-epic state for plugin mode |

Requires OpenClaw ≥ 2026.5.18 (declared as `openclaw.install.minHostVersion`).
