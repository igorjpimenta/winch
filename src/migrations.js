// migrations.js — Umzug owns the migration ledger; this module supplies the
// node:sqlite context, the schema_migrations storage, and the version guard.
//
// PRAGMA user_version remains the canonical integer (meta.schema_version is
// mirrored for pre-ledger stores). Umzug's schema_migrations table records
// which migration files ran, so future changes are append-only files rather
// than edits to a switch in store.js.
//
// This is not `winch migrate-store` (migrate.js); that copies a database.

import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Umzug } from "umzug";

export const SCHEMA_VERSION = 6;

const MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations");
const BASELINE_NAME = "0001-consolidated-v1-v6";

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

class SqliteStorage {
  constructor(db) {
    this.db = db;
  }

  ensure() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
  }

  async executed() {
    this.ensure();
    return this.db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r) => r.name);
  }

  async logMigration({ name }) {
    this.ensure();
    this.db.prepare(
      "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)"
    ).run(name, Date.now());
  }

  async unlogMigration({ name }) {
    this.ensure();
    this.db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(name);
  }
}

// Every migration runs in its own transaction. Umzug logs the migration after
// up() returns; a crash between COMMIT and logMigration replays the file on
// the next open, so migration files must stay idempotent.
function transactional(fn) {
  return async (params) => {
    const db = params.context.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(params);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
}

async function loadMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".mjs"))
    .sort();

  return Promise.all(files.map(async (file) => {
    const name = path.basename(file, ".mjs");
    const url = pathToFileURL(path.join(MIGRATIONS_DIR, file)).href;
    const mod = await import(url);
    if (typeof mod.up !== "function") {
      throw new Error(`winch: migration ${name} has no up()`);
    }
    return {
      name,
      up: transactional((params) => mod.up(params)),
      ...(typeof mod.down === "function"
        ? { down: transactional((params) => mod.down(params)) }
        : {}),
    };
  }));
}

export async function applyMigrations(db, { logger } = {}) {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `winch: store schema v${from} is newer than this build (v${SCHEMA_VERSION}); upgrade winch`
    );
  }

  const migrations = await loadMigrations();
  const known = new Set(migrations.map((m) => m.name));
  const storage = new SqliteStorage(db);
  const executed = await storage.executed();

  const unknown = executed.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `winch: store has migrations unknown to this build: ${unknown.join(", ")}; upgrade winch`
    );
  }

  // A pre-ledger store already carries the consolidated schema as a version
  // counter. Record the baseline so Umzug does not replay it; the file is
  // idempotent anyway, but the ledger should tell the truth.
  if (from >= SCHEMA_VERSION && !executed.includes(BASELINE_NAME)) {
    await storage.logMigration({ name: BASELINE_NAME });
  }

  const log = logger ?? { info() {}, warn() {}, error() {} };
  const umzug = new Umzug({
    migrations,
    context: { db, logger: log },
    storage,
    logger: log,
  });

  const applied = await umzug.up();
  writeVersion(db, SCHEMA_VERSION);
  return {
    from,
    to: SCHEMA_VERSION,
    applied: applied.map((m) => m.name),
  };
}
