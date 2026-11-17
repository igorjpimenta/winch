# @igorjpimenta/winch-openclaw

OpenClaw companion for [winch](https://github.com/igorjpimenta/winch). Three jobs:

1. **Identity** — `before_tool_call` stamps `_meta.winch {harness, agent, session}`
   onto every winch MCP tool call, overwriting unconditionally so model-supplied
   meta cannot impersonate an agent.
2. **Wake receiver** — serves `POST /api/winch/dispatch`, verifies the
   executor bearer, and starts a one-shot session for the assigned agent. The
   agent's `backlog_claim` is the work guard, so duplicate delivery is safe.
3. **Self-registration and recovery** — generates a stable executor id and
   bearer, registers the wake URL with winch on boot, and reconciles assigned
   `in_progress` work through `POST /dispatch/recover`.

## Install

```sh
openclaw plugins install @igorjpimenta/winch-openclaw --accept-capabilities
```

The manifest declares `activation.onStartup`, so the plugin loads at gateway
boot (without it the host never calls `register()` and the route never
binds). The `--accept-capabilities` flag is required: the plugin registers
an HTTP route and a service.

The plugin depends on `@igorjpimenta/winch`, so npm resolves and pins the
server version alongside it.

Set `dispatchPublicBaseUrl` if the gateway port isn't detectable. The plugin
generates its own bearer; there is no shared secret to configure. The route
stays disarmed until registration succeeds.

## Releases

Ships on its own line, independent of the core server:
`winch-openclaw-<semver>` tags publish `@igorjpimenta/winch-openclaw`
(stable → `latest`, prerelease → `beta`). Bump this package's `version` and
its `@igorjpimenta/winch` dependency floor together.

## Config

| key | default | meaning |
|---|---|---|
| `dispatchEnabled` | `true` | receive wakes and reconcile assigned `in_progress` work |
| `dispatchUrl` | `http://127.0.0.1:38291` | winch HTTP base URL |
| `dispatchPublicBaseUrl` | `http://127.0.0.1:<gateway.port>` | gateway address winch can reach |
| `dispatchHarness` | `openclaw` | harness name registered in winch (must match `WINCH_HARNESS`) |
| `dispatchReconcileMs` | `30000` | recovery interval |
| `dispatchStatePath` | `~/.openclaw/state/winch-dispatch.json` | stable executor id and bearer |
| `dispatchOpenclawBin` | shim beside the gateway entry | CLI used to start a wake session |

Requires OpenClaw ≥ 2026.5.18 (declared as `openclaw.install.minHostVersion`).
