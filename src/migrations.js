// migrations.js — schema migrations for the sqlite store. This is not the
// data-copy command (`winch migrate-store`, migrate.js); this advances the
// schema in place.
//
// Canonical counter: PRAGMA user_version. meta.schema_version is mirrored
// for stores created before user_version was written and for tooling that
// reads the old key. A store newer than this build refuses to open rather
// than operating on a schema it does not know.

import { SCHEMA } from "./schema.js";

export const SCHEMA_VERSION = 6;

function pragmaVersion(db) {
  const n = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function metaVersion(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!table) return 0;
  const n = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// Both counters are read because stores created before this runner wrote
// only meta.schema_version. The max prevents replaying a migration when one
// counter lags the other.
function currentVersion(db) {
  return Math.max(pragmaVersion(db), metaVersion(db));
}

function writeVersion(db, version) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec(`PRAGMA user_version = ${version}`);
  db.prepare(
    "INSERT INTO meta(key,value) VALUES('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(String(version));
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

// Version 6 is the consolidated baseline: the latest SCHEMA plus every
// guarded repair needed by v1–v5. Older stores jump straight here; stores
// already at 6 skip it. New schema changes append a migration with a higher
// version, never edit this one.
const MIGRATIONS = [
  {
    version: 6,
    name: "consolidated schema (v1–v6)",
    up(db, { logger } = {}) {
      db.exec(SCHEMA);
      ensureColumns(db);
      repairGraphFlowCheck(db, logger);
    },
  },
];

export function applyMigrations(db, { logger } = {}) {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `winch: store schema v${from} is newer than this build (v${SCHEMA_VERSION}); upgrade winch`
    );
  }

  const pending = MIGRATIONS
    .filter((m) => m.version > from)
    .sort((a, b) => a.version - b.version);

  const reachable = pending.at(-1)?.version ?? from;
  if (reachable < SCHEMA_VERSION) {
    throw new Error(
      `winch: no schema migration path from v${from} to v${SCHEMA_VERSION}`
    );
  }

  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db, { logger });
      db.exec("COMMIT");
      logger?.info?.(`winch: schema migration v${migration.version} applied (${migration.name})`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `winch: schema migration v${migration.version} (${migration.name}) failed: ${err?.message ?? err}`,
        { cause: err }
      );
    }
  }

  writeVersion(db, SCHEMA_VERSION);
  return { from, to: SCHEMA_VERSION, applied: pending.map((m) => m.version) };
}
