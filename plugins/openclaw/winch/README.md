# @igorjpimenta/winch-openclaw

OpenClaw companion for [winch](https://github.com/igorjpimenta/winch). Three jobs:

1. **Identity** — `before_tool_call` stamps `_meta.winch {harness, agent, session}`
   onto every winch MCP tool call, overwriting unconditionally so model-supplied
   meta cannot impersonate an agent.
2. **Wake receiver** — serves `POST /api/winch/dispatch`, verifies the
   executor bearer, and starts a one-shot session for the assigned agent. The
   agent's `backlog_claim` is the work guard, so duplicate delivery is safe.
3. **Self-registration and recovery** — registers the wake URL with
   `WINCH_EXECUTOR_ID` and `WINCH_DISPATCH_BEARER`, then reconciles assigned
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

Set `dispatchPublicBaseUrl` if the gateway port isn't detectable. Generate the
bearer with `winch webhook bearer`, then set `WINCH_DISPATCH_BEARER` and a unique
`WINCH_EXECUTOR_ID` in the gateway/plugin environment. The receiver stays
disarmed and logs a warning if either is missing.

## Releases

Ships on its own line, independent of the core server:
`winch-openclaw-<semver>` tags publish `@igorjpimenta/winch-openclaw`
(stable → `latest`, prerelease → `beta`). Bump this package's `version` and
its `@igorjpimenta/winch` dependency floor together.

## Config

| key | default | meaning |
|---|---|---|
| `dispatchEnabled` | `true` | receive wakes and reconcile assigned `in_progress` work |
| `dispatchPublicBaseUrl` | `http://127.0.0.1:<gateway.port>` | gateway address winch can reach |
| `winchHarness` | `WINCH_HARNESS` or `openclaw` | harness name for identity and dispatch |
| `winchExecutorId` | `WINCH_EXECUTOR_ID` | unique executor id for this connection |
| `dispatchReconcileMs` | `30000` | recovery interval |
| `dispatchOpenclawBin` | shim beside the gateway entry | CLI used to start a wake session |

Environment:

| variable | meaning |
|---|---|
| `WINCH_EXECUTOR_ID` | unique executor id; required unless `winchExecutorId` is set |
| `WINCH_DISPATCH_BEARER` | receiver token; generate with `winch webhook bearer` |
| `WINCH_DISPATCH_URL` | winch base URL, default `http://127.0.0.1:38293` |
| `WINCH_DISPATCH_PUBLIC_BASE_URL` | fallback for `dispatchPublicBaseUrl` |

Requires OpenClaw ≥ 2026.5.18 (declared as `openclaw.install.minHostVersion`).
