// wake.test.js — a dispatch wake is a detached agent process. It must not
// register its own dispatcher (that fans one wake into a self-spawning crowd),
// and the sweeper must reap only children whose spawning owner is gone — a
// child still owned by a live instance is doing real work.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a wake child is denied its own dispatch listener and forgets its record", { timeout: 30_000 }, async () => {
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
        // wake()'s child is unref'd so a bare caller is not held open by an
        // agent run; without a live handle here the loop can drain before the
        // child's exit event dispatches and the await never settles.
        const hold = setInterval(() => {}, 25);
        try {
          await runner.wake({ agent: "build", message: "ITM-env" });
        } finally {
          clearInterval(hold);
        }
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

test("a key already running rejects a second wake without spawning", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  const stateDir = path.join(dir, "state");
  const trace = path.join(dir, "trace.txt");
  const release = path.join(dir, "release.txt");
  const bin = fakeBin(dir, [
    'import { appendFileSync, existsSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'const message = args[3] ?? "x";',
    "appendFileSync(process.env.TRACE, `${message}\\n`);",
    "const tick = () => {",
    "  if (existsSync(process.env.RELEASE)) process.exit(0);",
    "  setTimeout(tick, 20);",
    "};",
    "tick();",
  ].join("\n"));
  try {
    await withEnv(
      { OPENCODE_BIN: bin, TRACE: trace, RELEASE: release, WINCH_DISPATCH_ENABLED: "0" },
      async () => {
        const runner = createWakeRunner({ logger: null, stateDir });
        const hold = setInterval(() => {}, 25);
        try {
          const first = runner.wake({ agent: "build", message: "ITM-one", key: "ADM-1", admissionId: "ADM-1" });
          const dup = await runner.wake({ agent: "build", message: "ITM-one", key: "ADM-1", admissionId: "ADM-1" });
          assert.deepEqual(dup, { deduped: true }, "the same key resolves deduplicated while its child lives");
          const traceText = () => (existsSync(trace) ? readFileSync(trace, "utf8") : "");
          const deadline = Date.now() + 10_000;
          while (!traceText().includes("ITM-one")) {
            if (Date.now() > deadline) throw new Error("timeout waiting for the child");
            await sleep(20);
          }
          assert.equal(traceText(), "ITM-one\n", "exactly one child for the key");
          writeFileSync(release, "1");
          await first;
        } finally {
          clearInterval(hold);
        }
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child exit settles the admission on the core", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  const stateDir = path.join(dir, "state");
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.statusCode = 202;
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bin = fakeBin(dir, "process.exit(0);\n");
  try {
    await withEnv({ OPENCODE_BIN: bin, WINCH_DISPATCH_ENABLED: "0" }, async () => {
      const runner = createWakeRunner({
        logger: null,
        stateDir,
        dispatchUrl: `http://127.0.0.1:${server.address().port}`,
        bearer: "tok",
        consumerId: "opencode:tui",
      });
      const hold = setInterval(() => {}, 25);
      try {
        await runner.wake({ agent: "build", message: "ITM-settle", key: "ADM-9", admissionId: "ADM-9" });
        const deadline = Date.now() + 5000;
        while (calls.length === 0 && Date.now() < deadline) await sleep(20);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "/dispatch/notify");
        assert.equal(calls[0].auth, "Bearer tok");
        assert.equal(calls[0].body.type, "settle");
        assert.equal(calls[0].body.admissionId, "ADM-9");
        assert.equal(calls[0].body.consumerId, "opencode:tui");
      } finally {
        clearInterval(hold);
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
