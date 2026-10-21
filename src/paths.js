// paths.js — winch's own data directory. The store belongs to the backlog
// server, not to whichever harness happens to launch it.
//
// Precedence: WINCH_DB, then BACKLOG_DB_PATH, then ~/.winch/store.sqlite.
// A store still at the pre-agnostic openclaw path keeps working until it is
// moved, so upgrading never silently starts an empty backlog.

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

export function defaultDbPath(home = os.homedir()) {
  return path.join(home, ".winch", "store.sqlite");
}

export function legacyDbPath(home = os.homedir()) {
  return path.join(home, ".openclaw", "backlog", "store.sqlite");
}

export function resolveDbPath({
  env = process.env,
  home = os.homedir(),
  warn = (msg) => console.error(msg),
} = {}) {
  const explicit = env.WINCH_DB || env.BACKLOG_DB_PATH;
  if (explicit) return explicit;

  const next = defaultDbPath(home);
  const legacy = legacyDbPath(home);
  if (existsSync(next) || !existsSync(legacy)) return next;

  warn(
    `winch: using legacy store at ${legacy}; ` +
      `run 'winch migrate-store' to move it to ${next}`
  );
  return legacy;
}
