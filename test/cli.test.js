// cli.test.js — construction rejects identity flags that belong to per-call meta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

test("winch mcp rejects --agent/--session with a per-call identity error", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(root, "bin/winch.js"), "mcp", "--harness", "test", "--agent", "a"],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /per-call identity, not construction flags/);
  assert.doesNotMatch(r.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
});
