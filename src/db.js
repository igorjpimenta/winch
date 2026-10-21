// db.js — the better-sqlite3 connection and Drizzle client. Schema changes
// are generated into drizzle/ from src/schema.js and applied here on open.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

const MIGRATIONS_FOLDER = path.join(import.meta.dirname, "..", ".migrations");

export function openDatabase({ dbPath, logger } = {}) {
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  const orm = drizzle(sqlite, { schema });
  migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });

  logger?.info?.(`backlog: store ready at ${dbPath}`);
  return { sqlite, orm };
}
