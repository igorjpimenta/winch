// migrate.js — copy a store without touching the source. VACUUM INTO reads a
// consistent snapshot (including committed WAL frames) and writes a compact
// database at the target path. The source is left in place for verification.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultDbPath, legacyDbPath } from "./paths.js";

export function migrateStore({ from, to, home } = {}) {
  const source = from ?? legacyDbPath(home);
  const target = to ?? defaultDbPath(home);

  if (!existsSync(source)) throw new Error(`source store not found: ${source}`);
  if (existsSync(target)) throw new Error(`target already exists: ${target}`);

  mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } catch (err) {
    rmSync(target, { force: true });
    throw err;
  } finally {
    db.close();
  }
  return { from: source, to: target };
}
