// schema.js — the current logical schema. The initial migration applies it
// to a fresh store; later changes are new files in src/migrations/.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS epics (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  acceptance  TEXT,
  status      TEXT NOT NULL CHECK (status IN ('idea','planned','in_progress','done','cancelled')),
  owner_team  TEXT,
  priority    INTEGER NOT NULL DEFAULT 50,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  closed_at   INTEGER
);

CREATE TABLE IF NOT EXISTS stories (
  id           TEXT PRIMARY KEY,
  epic_id      TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  acceptance   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('backlog','ready','in_progress','review','done','blocked','cancelled')),
  size         TEXT,
  priority     INTEGER NOT NULL DEFAULT 50,
  assigned     TEXT,
  capabilities TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  story_id         TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('todo','in_progress','done','blocked','cancelled')),
  execution_kind   TEXT NOT NULL CHECK (execution_kind IN ('pipeclaw','subagent','cli','gate','manual')),
  execution_args   TEXT NOT NULL DEFAULT '{}',
  assigned         TEXT,
  capabilities     TEXT,
  flow_id          TEXT,
  task_run_id      TEXT,
  claim_expires_at INTEGER,
  lease_seconds    INTEGER,
  last_heartbeat   INTEGER,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  gate_type        TEXT,
  blocked_at       INTEGER,
  result_summary   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  claimed_at       INTEGER,
  closed_at        INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT,
  note        TEXT,
  session_ref TEXT,
  at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deps (
  from_id    TEXT NOT NULL,
  from_kind  TEXT NOT NULL CHECK (from_kind IN ('epic','story','task')),
  to_id      TEXT NOT NULL,
  to_kind    TEXT NOT NULL CHECK (to_kind   IN ('epic','story','task')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_stories_epic              ON stories(epic_id);
CREATE INDEX IF NOT EXISTS idx_stories_status_assigned   ON stories(status, assigned);
CREATE INDEX IF NOT EXISTS idx_tasks_story               ON tasks(story_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_assigned     ON tasks(status, assigned);
CREATE INDEX IF NOT EXISTS idx_events_task               ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_deps_from                 ON deps(from_id);
CREATE INDEX IF NOT EXISTS idx_deps_to                   ON deps(to_id);

CREATE TABLE IF NOT EXISTS session_budgets (
  session_key   TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  limit_calls   INTEGER NOT NULL,
  exhausted_at  INTEGER,
  empty_wakes   INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
`;
