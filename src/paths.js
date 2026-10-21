// paths.js — winch's own data directory. The store belongs to the backlog
// server, not to whichever harness happens to launch it.
//
// Precedence: WINCH_DB, then BACKLOG_DB_PATH, then ~/.winch/store.sqlite.
// There is no implicit read of the old openclaw path: a breaking move is
// explicit, via `winch migrate-store` or an environment override.

import os from "node:os";
import path from "node:path";

export function defaultDbPath(home = os.homedir()) {
  return path.join(home, ".winch", "store.sqlite");
}

// Only the explicit migrate-store command reads this. Resolution never does.
export function legacyDbPath(home = os.homedir()) {
  return path.join(home, ".openclaw", "backlog", "store.sqlite");
}

export function resolveDbPath({ env = process.env, home = os.homedir() } = {}) {
  return env.WINCH_DB || env.BACKLOG_DB_PATH || defaultDbPath(home);
}
