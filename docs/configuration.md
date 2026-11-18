# Configuration

Tuning knobs are declared the way the harness is - and none of them is
required. Precedence per knob: per-call `_meta.winch.config` > constructor
`{ config }` (`createStore`, `--config JSON|PATH` on `mcp`/`serve`/`watch`)
> `WINCH_*` env > code default. Every knob has a default, so a server with no
overrides starts with dispatch enabled.

| knob | env | default |
|---|---|---|
| Claim lease | `WINCH_LEASE_SECONDS` | 1800 (30 min) |
| Sweeper max attempts | `WINCH_MAX_ATTEMPTS` | 3 |
| Gate-wait thresholds | `WINCH_GATE_WAIT_LEVELS` | 24h / 72h |
| WS port / history / poll | `WINCH_WS_PORT` / `WINCH_WS_HISTORY_LIMIT` / `WINCH_WS_INTERVAL_MS` | 38291 / 200 / 1000 ms |
| Dispatch port / poll / lease sweep | `WINCH_DISPATCH_PORT` / `WINCH_DISPATCH_INTERVAL_MS` / `WINCH_DISPATCH_SWEEP_MS` | 38293 / 1000 / 30000 ms |
| Dispatch caps per harness / global | `WINCH_DISPATCH_HARNESS_MAX` / `WINCH_DISPATCH_GLOBAL_MAX` | 8 / 16 |
| Dispatch consumer heartbeat TTL | `WINCH_DISPATCH_CONSUMER_TTL_MS` | 90000 ms |
| Offer TTL / base backoff / max backoff / attempts | `WINCH_DISPATCH_OFFER_MS` / `WINCH_DISPATCH_OFFER_BACKOFF_MS` / `WINCH_DISPATCH_OFFER_MAX_BACKOFF_MS` / `WINCH_DISPATCH_OFFER_MAX_ATTEMPTS` | 120000 / 30000 / 300000 ms / 5 |
| Webhook delivery timeout | `WINCH_WEBHOOK_TIMEOUT_MS` | 3000 ms |
| MCP HTTP port | `WINCH_MCP_HTTP_PORT` | 38292 |
| DB path | `WINCH_DB` | `~/.winch/store.sqlite` |
| Wake routing cap | `WINCH_MAX_ACTIVE_PER_AGENT` | 2 |
| Scan limits | `WINCH_SCAN_LIMIT` / `WINCH_CANDIDATES` / `WINCH_BLOCKED_LIMIT` | 50 / 5 / 20 |
| Dep cycle-check cap | `WINCH_DFS_NODES` | 500 nodes |
| Note caps | `WINCH_NOTE_{PROGRESS,RESULT,REASON,ARTIFACT}_LIMIT` | 2000 / 4000 / 1000 / 500 |
| Artifacts per done | `WINCH_MAX_ARTIFACTS` | 50 |
