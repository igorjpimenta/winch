// 0001-initial — create the current schema. Fresh stores start here; later
// schema changes are new files, not edits to this one.

import { SCHEMA } from "../schema.js";

export async function up({ context }) {
  context.db.exec(SCHEMA);
}

export async function down({ context }) {
  context.db.exec(`
    DROP TABLE IF EXISTS session_budgets;
    DROP TABLE IF EXISTS deps;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS stories;
    DROP TABLE IF EXISTS epics;
  `);
}
