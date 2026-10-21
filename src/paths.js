// paths.js — winch's own data directory. The store belongs to the backlog
// server, not to whichever harness happens to launch it.
//
// Precedence: WINCH_DB, then ~/.winch/store.sqlite. There is no second env
// alias and no implicit legacy path: migration is explicit, via
// `winch migrate-store --from <path>` or WINCH_DB.

import os from "node:os";
import path from "node:path";

export function defaultDbPath(home = os.homedir()) {
  return path.join(home, ".winch", "store.sqlite");
}

export function resolveDbPath({ env = process.env, home = os.homedir() } = {}) {
  return env.WINCH_DB || defaultDbPath(home);
}
