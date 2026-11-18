// wake.test.js — a dispatch wake is a detached agent process. It must not
// register its own dispatcher (that fans one wake into a self-spawning crowd),
// and the sweeper must reap only children whose spawning owner is gone — a
// child still owned by a live instance is doing real work.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWakeRunner } from "../../../../../plugins/opencode/winch/index.js";

function fakeBin(dir, body) {
  const file = path.join(dir, "fake-opencode.mjs");
  writeFileSync(file, `#!${process.execPath}\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deadPid() {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "exit");
  return pid;
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

test("a wake child is denied its own dispatch listener and forgets its record", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  const out = path.join(dir, "env.txt");
  const stateDir = path.join(dir, "state");
  try {
    await withEnv(
      {
        OPENCODE_BIN: fakeBin(dir, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUT, String(process.env.WINCH_DISPATCH_ENABLED));\n`),
        OUT: out,
        WINCH_DISPATCH_ENABLED: "1",
      },
      async () => {
        const runner = createWakeRunner({ logger: null, stateDir });
        await runner.wake({ agent: "build", message: "ITM-env" });
        assert.equal(readFileSync(out, "utf8"), "0");
        assert.deepEqual(readdirSync(stateDir), [], "record removed when the child exits");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reaps only wake children whose spawning owner is gone", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  const stateDir = path.join(dir, "state");
  const bin = fakeBin(dir, `setInterval(() => {}, 1000);\n`);
  const alive = spawn(bin, ["run", "--agent", "build", "ITM-alive"], { detached: true, stdio: "ignore" });
  const orphan = spawn(bin, ["run", "--agent", "build", "ITM-orphan"], { detached: true, stdio: "ignore" });
  try {
    await sleep(120); // let both exec so their command line is readable
    const owner = await deadPid();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, `wake-${process.pid}-${alive.pid}.json`),
      JSON.stringify({ pid: alive.pid, ownerPid: process.pid, agent: "build", message: "ITM-alive" }),
    );
    writeFileSync(
      path.join(stateDir, `wake-${owner}-${orphan.pid}.json`),
      JSON.stringify({ pid: orphan.pid, ownerPid: owner, agent: "build", message: "ITM-orphan" }),
    );

    const runner = createWakeRunner({ logger: null, stateDir });
    assert.equal(runner.reapOrphans(), 1);
    await once(orphan, "exit");
    assert.equal(alive.exitCode, null, "a child of a live owner must keep running");
    assert.equal(alive.signalCode, null);
  } finally {
    alive.kill("SIGKILL");
    orphan.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drops records whose child already exited", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  const stateDir = path.join(dir, "state");
  try {
    const child = await deadPid();
    const owner = await deadPid();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, `wake-${owner}-${child}.json`),
      JSON.stringify({ pid: child, ownerPid: owner, agent: "build", message: "ITM-gone" }),
    );
    const runner = createWakeRunner({ logger: null, stateDir });
    assert.equal(runner.reapOrphans(), 0);
    assert.deepEqual(readdirSync(stateDir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
