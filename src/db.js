// db.js — the better-sqlite3 connection and Drizzle client. Schema changes
// are generated into .migrations/ from src/schema.js and applied here on open.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableColumns } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

const MIGRATIONS_FOLDER = path.join(import.meta.dirname, "..", ".migrations");
const MANAGED_TABLES = ["epics", "stories", "tasks", "events", "deps"];

export function openDatabase({ dbPath, logger } = {}) {
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  const orm = drizzle(sqlite, { schema });
  adoptLegacyStore(sqlite, dbPath);
  migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });

  logger?.info?.(`backlog: store ready at ${dbPath}`);
  return { sqlite, orm };
}

/**
 * Pre-drizzle stores have the tables but no migration ledger, so the
 * migrator would replay 0000's bare CREATE TABLEs and die. Adoption marks
 * the baseline applied and lets pending migrations (kind column, budget
 * drop) run normally — but only for stores shaped like the schema expects.
 * Anything else fails here with the actual gap named, instead of a cryptic
 * CREATE TABLE error mid-migrate. Fresh files (no managed tables at all)
 * skip adoption and migrate from zero.
 */
function adoptLegacyStore(sqlite, dbPath) {
  const present = new Set(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  if (present.has("__drizzle_migrations")) return;
  if (!MANAGED_TABLES.some((t) => present.has(t))) return;
  for (const [tname, table] of Object.entries({ epics: schema.epics, stories: schema.stories, tasks: schema.tasks, events: schema.events, deps: schema.deps })) {
    if (!present.has(tname)) {
      throw new Error(`winch: store at ${dbPath} is not adoptable (missing table ${tname}) — start fresh or export first.`);
    }
    const want = new Set(Object.values(getTableColumns(table)).map((c) => c.name));
    if (tname === "events") want.delete("kind"); // added by migration 0001 itself
    const have = new Set(sqlite.prepare(`PRAGMA table_info(${tname})`).all().map((r) => r.name));
    for (const col of want) {
      if (!have.has(col)) {
        throw new Error(`winch: store at ${dbPath} is not adoptable (${tname} missing column ${col}) — start fresh or export first.`);
      }
    }
  }
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
  const baseline = journal.entries[0];
  sqlite.exec("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)");
  sqlite.prepare("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)").run(`baseline:${baseline.tag}`, baseline.when);
}
