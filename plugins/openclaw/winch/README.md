# @igorjpimenta/winch-openclaw

OpenClaw companion for [winch](https://github.com/igorjpimenta/winch). Four jobs:

1. **Identity** — `before_tool_call` stamps `_meta.winch {harness, agent, session}`
   onto every winch MCP tool call, overwriting unconditionally so model-supplied
   meta cannot impersonate an agent.
2. **Wake receiver** — serves `POST /api/winch/dispatch`, verifies the
   executor bearer, deduplicates on
   `admissionId + attemptNo`, and starts a one-shot session. Tasks use
   `backlog_claim`; planner wakes must call `backlog_accept_wake` with the
   payload lease before working.
3. **Self-registration and recovery** — registers one wake URL per
   `WINCH_CONSUMER_ID` with `WINCH_WEBHOOK_BEARER`, then reconciles assigned
   `in_progress` work through `POST /dispatch/recover`. The first run is
   `fresh: true`; later heartbeats preserve failure state. `WINCH_EXECUTOR_ID`
   identifies the live connection; the event's `kind` selects the listener
   action. Set `WINCH_DISPATCH_TOKEN` for authenticated management calls.
4. **Usage reporting** — `llm_output` sums each attempt's token counts into a
   per-run accumulator; `agent_end` (once per run) and `reply_payload_sending`
   (fallback) flush it to winch's `POST /usage` under the session's
   `harness:agent:session` key with `turnRef = runId`, so the server's unique
   index dedupes a double flush. Only sessions bound to an item (a winch call
   carrying an item id) flush. The host does not attach `usageState` to reply
   hooks on agent-command runs — it consumes the recorded snapshot only for
   inbound replies — so the accumulator is the primary source and `usageState`
   the inbound fallback. Posts are fire-and-forget and never delay or fail the
   turn; they use `WINCH_DISPATCH_URL` and `WINCH_DISPATCH_TOKEN`.
   `llm_output`/`agent_end` require `plugins.entries.winch.hooks.
   allowConversationAccess=true` in openclaw.json: the host blocks those hook
   names for non-bundled plugins without it, and a blocked registration is
   logged as a warning but the gateway keeps running without usage reporting.

## Install

```sh
openclaw plugins install @igorjpimenta/winch-openclaw --accept-capabilities
```

The manifest declares `activation.onStartup`, so the plugin loads at gateway
boot (without it the host never calls `register()` and the route never
binds). The `--accept-capabilities` flag is required: the plugin registers
an HTTP route and a service.

The plugin talks to the winch server over HTTP (`WINCH_DISPATCH_URL`,
default `http://127.0.0.1:38293`) and does not bundle the server. The core
server is installed separately (`npm i -g @igorjpimenta/winch`).

Set `dispatchPublicBaseUrl` if the gateway port isn't detectable. Generate the
bearer with `winch webhook bearer`, then set `WINCH_WEBHOOK_BEARER` and a unique
`WINCH_EXECUTOR_ID` in the gateway/plugin environment. `WINCH_CONSUMER_ID`
defaults to `harness:hostname`, so the gateway keeps one route across restarts.
The receiver stays disarmed and logs a warning if the executor or bearer is
missing.

## Releases

Ships on its own line, independent of the core server:
`winch-openclaw-<semver>` tags publish `@igorjpimenta/winch-openclaw`
(stable → `latest`, prerelease → `beta`). Bump this package's `version`
on each release; there is no npm dependency on the core server.

## Config

| key | default | meaning |
|---|---|---|
| `dispatchEnabled` | `true` | receive wakes and reconcile assigned `in_progress` work |
| `dispatchPublicBaseUrl` | `http://127.0.0.1:<gateway.port>` | gateway address winch can reach |
| `winchHarness` | `WINCH_HARNESS` or `openclaw` | harness name for identity and dispatch |
| `winchExecutorId` | `WINCH_EXECUTOR_ID` | unique instance id for this connection; also the registration lease owner |
| `winchConsumerId` | `WINCH_CONSUMER_ID` or `harness:hostname` | stable webhook identity |
| `dispatchReconcileMs` | `30000` | recovery interval |
| `dispatchOpenclawBin` | shim beside the gateway entry | CLI used to start a wake session |

Environment:

| variable | meaning |
|---|---|
| `WINCH_EXECUTOR_ID` | unique instance id; required unless `winchExecutorId` is set |
| `WINCH_CONSUMER_ID` | stable webhook identity; default `harness:hostname` |
| `WINCH_WEBHOOK_BEARER` | receiver token; generate with `winch webhook bearer` |
| `WINCH_DISPATCH_URL` | winch base URL, default `http://127.0.0.1:38293` |
| `WINCH_DISPATCH_PUBLIC_BASE_URL` | fallback for `dispatchPublicBaseUrl` |
| `WINCH_DISPATCH_TOKEN` | management bearer for register/recover/notify; required for a non-loopback winch bind |

Requires OpenClaw ≥ 2026.5.18 (declared as `openclaw.install.minHostVersion`).

## Human artifacts (HITL)

This plugin adds no HITL logic — the server owns it. What an OpenClaw session
needs to know:

- **Agents** get the PR protocol from the claim handoff's `receiverPrompt`:
  put `Backlog:` / `Backlog-Task:` in the PR body, attach with
  `backlog_update({ addArtifact: "<pr-url>", addArtifactKind: "pr" })` while
  `in_progress`, and never `backlog_done` while a review child is open.
- **Operators** list the human queue with `winch hitl` (not `winch next`,
  which excludes `human`). Resolve a non-PR child with
  `winch resolve <taskId> --note "…"`. For PR children, merge on GitHub —
  `merge-detect` closes the child and frees the parent within its schedule.
- **Wakes never target humans**: the reserved `human`/`human_in_the_loop`
  pair is excluded from agent wake lists; the gateway will not start a
  session for a review child.
