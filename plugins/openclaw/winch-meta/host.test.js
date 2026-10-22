// host.test.js — pure-function tests for the minimum-host floor; runs
// under `node --test plugins/` with no gateway runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_HOST_VERSION,
  parseVersion,
  compareVersions,
  readHostVersion,
  checkHostFloor,
} from "./host.js";

test("floor constant pins the verified stable", () => {
  assert.equal(MIN_HOST_VERSION, "2026.5.18");
});

test("parseVersion handles calver, v-prefix, prereleases, garbage", () => {
  assert.deepEqual(parseVersion("2026.5.18"), { core: [2026, 5, 18], pre: null });
  assert.deepEqual(parseVersion("v2026.5.16-beta.7"), { core: [2026, 5, 16], pre: "beta.7" });
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("  "), null);
  assert.equal(parseVersion("not-a-version"), null);
  assert.equal(parseVersion("2026.x.1"), null);
  assert.equal(parseVersion(42), null);
  assert.equal(parseVersion(null), null);
});

test("compareVersions orders cores, prerelease loses to release", () => {
  assert.equal(compareVersions("2026.5.6", "2026.5.18"), -1);
  assert.equal(compareVersions("2026.5.18", "2026.5.6"), 1);
  assert.equal(compareVersions("2026.5.18", "2026.5.18"), 0);
  assert.equal(compareVersions("2026.5.16-beta.7", "2026.5.18"), -1);
  assert.equal(compareVersions("2026.5.18-beta.1", "2026.5.18"), -1);
  assert.equal(compareVersions("2026.10.6", "2026.5.18"), 1);
  assert.equal(compareVersions("garbage", "2026.5.18"), null);
  assert.equal(compareVersions("2026.5.18", "garbage"), null);
});

test("readHostVersion prefers api fields over env, skips blanks", () => {
  assert.equal(readHostVersion({ version: "2026.10.6" }, {}), "2026.10.6");
  assert.equal(
    readHostVersion({ hostVersion: "2026.9.1" }, { OPENCLAW_VERSION: "2026.10.6" }),
    "2026.9.1",
  );
  assert.equal(readHostVersion({}, { OPENCLAW_VERSION: "2026.10.6" }), "2026.10.6");
  assert.equal(readHostVersion({ version: "  " }, {}), null);
  assert.equal(readHostVersion(null, {}), null);
  assert.equal(readHostVersion({}, {}), null);
});

test("checkHostFloor refuses below floor, passes above, warns when blind", () => {
  const below = checkHostFloor({ version: "2026.5.6" }, {});
  assert.equal(below.ok, false);
  assert.match(below.reason, /2026\.5\.6.*floor 2026\.5\.18/);

  const beta = checkHostFloor({ version: "2026.5.16-beta.7" }, {});
  assert.equal(beta.ok, false);

  const above = checkHostFloor({ version: "2026.10.6" }, {});
  assert.deepEqual(above, { ok: true, version: "2026.10.6" });

  const exact = checkHostFloor({ version: "2026.5.18" }, {});
  assert.equal(exact.ok, true);

  const blind = checkHostFloor({}, {});
  assert.deepEqual(blind, { ok: true, version: null, warned: true });

  const garbage = checkHostFloor({ version: "someday" }, {});
  assert.deepEqual(garbage, { ok: true, version: "someday", warned: true });
});
