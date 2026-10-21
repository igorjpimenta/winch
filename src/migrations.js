// migrations.js — Umzug runs the schema files in src/migrations/ and records
// what ran in schema_migrations. A fresh store runs the initial migration;
// a ledger row unknown to this build refuses to open.

import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Umzug } from "umzug";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations");

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

  const log = logger ?? { info() {}, warn() {}, error() {} };
  const umzug = new Umzug({
    migrations,
    context: { db, logger: log },
    storage,
    logger: log,
  });

  const applied = await umzug.up();
  return { applied: applied.map((m) => m.name) };
}
