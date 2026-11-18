// wake.test.js — a dispatch wake is a detached agent process, so it must never
// register its own dispatcher (that fans one wake into a self-spawning crowd),
// must be bounded in time, and must be reapable at shutdown.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWakeRunner } from "../../../../../plugins/opencode/winch/index.js";

function fakeBin(dir, body) {
  const file = path.join(dir, "fake-opencode.mjs");
  writeFileSync(file, `#!${process.execPath}\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test("a wake child is denied its own dispatch listener", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  const out = path.join(dir, "env.txt");
  try {
    await withEnv(
      {
        OPENCODE_BIN: fakeBin(dir, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUT, String(process.env.WINCH_DISPATCH_ENABLED));\n`),
        OUT: out,
        WINCH_DISPATCH_ENABLED: "1",
      },
      async () => {
        const runner = createWakeRunner({ logger: null, timeoutMs: 5000 });
        await runner.wake({ agent: "build", message: "ITM-env" });
        assert.equal(readFileSync(out, "utf8"), "0");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wake that never exits is reaped at the timeout", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  try {
    await withEnv(
      { OPENCODE_BIN: fakeBin(dir, `setInterval(() => {}, 1000);\n`) },
      async () => {
        const runner = createWakeRunner({ logger: null, timeoutMs: 150 });
        await assert.rejects(runner.wake({ agent: "build", message: "ITM-hang" }), /exit/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killAll reaps in-flight wakes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  try {
    await withEnv(
      { OPENCODE_BIN: fakeBin(dir, `setInterval(() => {}, 1000);\n`) },
      async () => {
        const runner = createWakeRunner({ logger: null, timeoutMs: 60000 });
        const pending = runner.wake({ agent: "build", message: "ITM-live" });
        await new Promise((r) => setTimeout(r, 100));
        runner.killAll();
        await assert.rejects(pending, /exit/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
