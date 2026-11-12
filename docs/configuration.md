# Configuration

Tuning knobs are declared the way the harness is - and none of them is
required. Precedence per knob: per-call `_meta.winch.config` > constructor
`{ config }` (`createStore`, `--config JSON|PATH` on `mcp`/`serve`/`watch`)
> `WINCH_*` env > code default. An undeclared server behaves exactly like
the old hardcoded one.

| knob | env | default |
|---|---|---|
| Claim lease | `WINCH_LEASE_SECONDS` | 1800 (30 min) |
| Sweeper max attempts | `WINCH_MAX_ATTEMPTS` | 3 |
| Gate-wait thresholds | `WINCH_GATE_WAIT_LEVELS` | 24h / 72h |
| WS port / history / poll | `WINCH_WS_PORT` / `WINCH_WS_HISTORY_LIMIT` / `WINCH_WS_INTERVAL_MS` | 38291 / 200 / 1000 ms |
| MCP HTTP port | `WINCH_MCP_HTTP_PORT` | 38292 |
| DB path | `WINCH_DB` | `~/.winch/store.sqlite` |
| Claim webhook URL / bearer / timeout | `WINCH_CLAIM_WEBHOOK_URL` / `WINCH_CLAIM_WEBHOOK_BEARER` / `WINCH_CLAIM_WEBHOOK_TIMEOUT_MS` | unset / unset / 3000 ms |
| Claim webhooks per harness (map) | `WINCH_CLAIM_WEBHOOKS` | `{}` (falls back to single URL) |
| Wake routing cap | `WINCH_MAX_ACTIVE_PER_AGENT` | 2 |
| Scan limits | `WINCH_SCAN_LIMIT` / `WINCH_CANDIDATES` / `WINCH_BLOCKED_LIMIT` | 50 / 5 / 20 |
| Dep cycle-check cap | `WINCH_DFS_NODES` | 500 nodes |
| Note caps | `WINCH_NOTE_{PROGRESS,RESULT,REASON,ARTIFACT}_LIMIT` | 2000 / 4000 / 1000 / 500 |
| Artifacts per done | `WINCH_MAX_ARTIFACTS` | 50 |
| Optional LLM cost tracking | `WINCH_COST_TRACKING` | true (set false to disable recording of stamped usage) |
