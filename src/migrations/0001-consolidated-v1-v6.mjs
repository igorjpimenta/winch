// 0001-consolidated-v1-v6 — the baseline that converges every pre-ledger
// store on the current schema. It is idempotent: SCHEMA creates what is
// missing, ensureColumns adds what an old table lacks, and the graph_flow
// rebuild only runs when the stale CHECK is present.
//
// The runner owns the transaction; this file must not start one.

import { SCHEMA } from "../schema.js";

export async function up({ context }) {
  const { db, logger } = context;
  db.exec(SCHEMA);
  ensureColumns(db);
  repairGraphFlowCheck(db, logger);
}

export async function down({ context }) {
  context.db.exec(`
    DROP TABLE IF EXISTS session_budgets;
    DROP TABLE IF EXISTS deps;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS stories;
    DROP TABLE IF EXISTS epics;
    DROP TABLE IF EXISTS meta;
  `);
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

// v1 → v6 column upgrades. PRAGMA-guarded so the step is idempotent on a
// store that already has the columns; CREATE TABLE IF NOT EXISTS in SCHEMA
// cannot add columns to a pre-existing table.
function ensureColumns(db) {
  const tasks = columns(db, "tasks");
  if (!tasks.has("lease_seconds"))  db.exec("ALTER TABLE tasks ADD COLUMN lease_seconds INTEGER");
  if (!tasks.has("last_heartbeat")) db.exec("ALTER TABLE tasks ADD COLUMN last_heartbeat INTEGER");
  if (!tasks.has("attempt_count"))  db.exec("ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
  if (!tasks.has("gate_type"))      db.exec("ALTER TABLE tasks ADD COLUMN gate_type TEXT");
  if (!tasks.has("blocked_at"))     db.exec("ALTER TABLE tasks ADD COLUMN blocked_at INTEGER");

  const budgets = columns(db, "session_budgets");
  if (!budgets.has("empty_wakes")) {
    db.exec("ALTER TABLE session_budgets ADD COLUMN empty_wakes INTEGER NOT NULL DEFAULT 0");
  }

  const events = columns(db, "events");
  if (!events.has("session_ref")) db.exec("ALTER TABLE events ADD COLUMN session_ref TEXT");
}

// The graph-flow→pipeclaw rename changed code, not CHECK constraints:
// CREATE TABLE IF NOT EXISTS never rewrites a legacy table's vocabulary, so
// a store born before the rename rejects every pipeclaw-kind insert. Detect
// the stale constraint and rebuild the table (renaming stored values too) —
// otherwise execution_kind='pipeclaw' is uninsertable on migrated stores.
function repairGraphFlowCheck(db, logger) {
  const tasksSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
  ).get()?.sql ?? "";
  if (!tasksSql.includes("'graph_flow'")) return;

  const oldCols = db.prepare("PRAGMA table_info(tasks)").all().map((r) => r.name);
  const keep = oldCols.map((c) => `"${c}"`).join(", ");
  // Rename in-flight: inserting the legacy 'graph_flow' value first would
  // violate the rebuilt table's CHECK before any UPDATE could fix it.
  const sel = oldCols.map((c) => (c === "execution_kind"
    ? `CASE WHEN "execution_kind"='graph_flow' THEN 'pipeclaw' ELSE "execution_kind" END`
    : `"${c}"`)).join(", ");

  db.exec(`
    CREATE TABLE tasks_rebuild (
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
    INSERT INTO tasks_rebuild (${keep})
    SELECT ${sel} FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_rebuild RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS idx_tasks_story            ON tasks(story_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status_assigned  ON tasks(status, assigned);
  `);
  logger?.info?.("backlog: repaired stale graph_flow execution_kind CHECK (table rebuilt, values renamed)");
}
