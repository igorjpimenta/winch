// autoregister.test.js — self-wiring: registers the route in winch on boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoregister, autoregisterConfig, manualCommand } from "./autoregister.js";

function apiWith(config = {}, gatewayPort = 18789) {
  const logs = { info: [], warn: [] };
  return {
    api: {
      pluginConfig: config,
      config: { gateway: { port: gatewayPort } },
      logger: {
        info: (m) => logs.info.push(String(m)),
        warn: (m) => logs.warn.push(String(m)),
      },
    },
    logs,
  };
}

function okRunner(calls) {
  return (bin, args, cb) => {
    calls.push([bin, ...args]);
    cb(null, "{}", "");
  };
}

test("disarmed without bearer; disabled flag respected", async () => {
  const { api } = apiWith({ webhookPublicBaseUrl: "http://127.0.0.1:18789" });
  assert.deepEqual((await autoregister({ api })).reason, "disarmed");
  const off = apiWith({ webhookBearer: "s", webhookAutoregister: false });
  assert.deepEqual(await autoregister({ api: off.api }), { ok: false, reason: "disabled" });
});

test("no base url and no port: manual command, nothing executed", async () => {
  const calls = [];
  const { api } = apiWith({ webhookBearer: "s" }, null);
  const r = await autoregister({ api, runner: okRunner(calls) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-base-url");
  assert.match(r.manual, /winch webhook set/);
  assert.equal(calls.length, 0);
});

test("happy path: set then test with derived url and bearer", async () => {
  const calls = [];
  const { api } = apiWith({ webhookBearer: "s3cret", webhookPublicBaseUrl: "http://127.0.0.1:18789/" });
  const r = await autoregister({ api, runner: okRunner(calls) });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls[0], [
    "winch", "webhook", "set",
    "--harness", "openclaw", "--url", "http://127.0.0.1:18789/api/winch/claimed", "--bearer", "s3cret",
  ]);
  assert.deepEqual(calls[1], ["winch", "webhook", "test", "--harness", "openclaw"]);
});

test("set failure never throws; returns manual command", async () => {
  const { api } = apiWith({ webhookBearer: "s", webhookPublicBaseUrl: "http://h:1" });
  const r = await autoregister({
    api,
    runner: (bin, args, cb) => cb(new Error("boom"), "", "nope"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "set-failed");
  assert.match(r.manual, /winch webhook set/);
});

test("bundled .js bin runs under the current node, not a PATH shim", async () => {
  const calls = [];
  const { api } = apiWith({ webhookBearer: "s", webhookPublicBaseUrl: "http://h:1", webhookWinchBin: "/opt/pkg/bin/winch.js" });
  const r = await autoregister({ api, runner: okRunner(calls) });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0][0], process.execPath);
  assert.equal(calls[0][1], "/opt/pkg/bin/winch.js");
  assert.deepEqual(calls[0].slice(2), ["webhook", "set", "--harness", "openclaw", "--url", "http://h:1/api/winch/claimed", "--bearer", "s"]);
});

test("bundled dependency resolves when no explicit bin is configured", () => {
  const c = autoregisterConfig({ webhookBearer: "s" }, { gateway: { port: 1 } });
  // The plugin declares @igorjpimenta/winch as a dependency; in the test
  // tree it resolves to this repo's bin, otherwise the PATH fallback stands.
  assert.match(c.winchBin, /winch\.js$|^winch$/);
});

test("config: gateway port fallback, harness and bin overrides", () => {
  const c = autoregisterConfig({ webhookBearer: "s" }, { gateway: { port: 9999 } });
  assert.equal(c.baseUrl, "http://127.0.0.1:9999");
  assert.equal(c.harness, "openclaw");
  const o = autoregisterConfig({ webhookBearer: "s", webhookHarness: "oc2", webhookWinchBin: "/x/w", webhookPublicBaseUrl: "http://g/" });
  assert.equal(o.harness, "oc2");
  assert.equal(o.winchBin, "/x/w");
  assert.equal(o.baseUrl, "http://g/");
  assert.match(manualCommand({ baseUrl: null, harness: "oc", bearer: "" }), /<gateway-url>/);
});
