# @igorjpimenta/winch-openclaw

OpenClaw companion for [winch](https://github.com/igorjpimenta/winch). Three jobs:

1. **Identity** — `before_tool_call` stamps `_meta.winch {harness, agent, session}`
   onto every winch MCP tool call, overwriting unconditionally so model-supplied
   meta cannot impersonate an agent.
2. **Claim receiver** — serves `POST /api/winch/claimed`; verifies the bearer,
   then opens a fresh one-shot session (`winch-claim-<TASK-ID>`) carrying the
   receiver prompt. Falls back to the claiming session, then to the heartbeat
   queue (no-Cron path).
3. **Self-registration** — on boot, registers its own route in winch
   (`winch webhook set` + `test`) so the operator has nothing to wire by hand.

## Install

```sh
openclaw plugins install @igorjpimenta/winch-openclaw
```

Then set the shared secret in the plugin config (`webhookBearer`), and
`webhookPublicBaseUrl` if the gateway port isn't detectable. The route stays
disarmed (503) until `webhookBearer` is set.

## Config

| key | default | meaning |
|---|---|---|
| `webhookBearer` | — | secret winch sends; must match `WINCH_CLAIM_WEBHOOK_BEARER` |
| `webhookPublicBaseUrl` | `http://127.0.0.1:<gateway.port>` | address winch can reach |
| `webhookHarness` | `openclaw` | harness name registered in winch (must match `WINCH_HARNESS`) |
| `webhookAutoregister` | `true` | self-register the route on boot |
| `webhookWinchBin` | `WINCH_BIN` or `winch` | binary used for self-registration |

Requires OpenClaw ≥ 2026.5.18 (declared as `openclaw.install.minHostVersion`).
