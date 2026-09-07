import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertServingChildHealth,
  createServerChildLaunch,
  createServingChildWatchdog,
} from "../serving-child-watchdog.mjs";

function createHarness(options = {}) {
  let now = 0;
  let probeError = null;
  const recoveries = [];
  const failures = [];
  const watchdog = createServingChildWatchdog({
    probe: async () => {
      if (probeError) throw probeError;
    },
    recover: async (reason) => {
      recoveries.push(reason);
    },
    failClosed: async (error) => {
      failures.push(error);
    },
    now: () => now,
    startupGraceMs: 100,
    restartGraceMs: 100,
    failureThreshold: 3,
    maxRecoveryAttempts: 2,
    ...options,
  });

  return {
    watchdog,
    recoveries,
    failures,
    advance(ms) {
      now += ms;
    },
    setProbeError(error) {
      probeError = error;
    },
  };
}

test("recovers only after a previously healthy server misses the failure threshold", async () => {
  const harness = createHarness();
  await harness.watchdog.checkNow();
  harness.setProbeError(new Error("connection refused"));

  await harness.watchdog.checkNow();
  await harness.watchdog.checkNow();
  assert.equal(harness.recoveries.length, 0);

  harness.advance(100);
  await harness.watchdog.checkNow();
  assert.deepEqual(harness.recoveries, ["health_check_failed"]);
  assert.equal(harness.failures.length, 0);
});

test("allows an in-process reload to finish before restarting the watcher", async () => {
  const harness = createHarness();
  await harness.watchdog.checkNow();
  harness.setProbeError(new Error("connection refused during reload"));

  await harness.watchdog.checkNow();
  harness.advance(50);
  await harness.watchdog.checkNow();
  await harness.watchdog.checkNow();
  assert.deepEqual(harness.recoveries, []);

  harness.setProbeError(null);
  await harness.watchdog.checkNow();
  harness.advance(100);
  harness.setProbeError(new Error("another reload"));
  await harness.watchdog.checkNow();
  await harness.watchdog.checkNow();
  await harness.watchdog.checkNow();
  assert.deepEqual(harness.recoveries, [], "a recovered server gets a fresh grace period");

  harness.advance(100);
  await harness.watchdog.checkNow();
  assert.deepEqual(harness.recoveries, ["health_check_failed"]);
});

test("watch mode ignores SDK build output while reloading SDK source changes", { timeout: 20_000 }, async (t) => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  // tsx ignores hidden directories, including the usual .agent-scratch root.
  const scratch = path.join(repoRoot, "tmp");
  await mkdir(scratch, { recursive: true });
  const fixture = await mkdtemp(path.join(scratch, "sdk-watch-"));
  const sdk = path.join(fixture, "packages/plugins/sdk");
  const server = path.join(fixture, "server");
  let child;
  let exited;
  let spawnError;
  let output = "";
  t.after(async () => {
    try {
      if (child && !spawnError && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
  await Promise.all([
    mkdir(path.join(sdk, "src"), { recursive: true }),
    mkdir(path.join(sdk, "dist"), { recursive: true }),
    mkdir(path.join(server, "src"), { recursive: true }),
    mkdir(path.join(fixture, "node_modules/@paperclipai"), { recursive: true }),
  ]);
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "packages/plugins/sdk/package.json"), "utf8"));
  await Promise.all([
    writeFile(path.join(sdk, "package.json"), JSON.stringify(manifest)),
    writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" })),
    writeFile(path.join(sdk, "src/index.ts"), "export const value: string = 'source';\n"),
    writeFile(path.join(sdk, "src/testing.ts"), "export const testValue: string = 'source-test';\n"),
    writeFile(path.join(sdk, "dist/index.js"), "export const value = 'build';\n"),
    writeFile(path.join(sdk, "dist/testing.js"), "export const testValue = 'build-test';\n"),
    writeFile(path.join(server, "src/index.ts"),
      "import { value } from '@paperclipai/plugin-sdk';\n" +
      "import { testValue } from '@paperclipai/plugin-sdk/testing';\n" +
      "console.log('BOOT', process.pid, value, testValue); setInterval(() => {}, 1000);\n"),
    symlink(sdk, path.join(fixture, "node_modules/@paperclipai/plugin-sdk"), process.platform === "win32" ? "junction" : "dir"),
  ]);
  const launch = createServerChildLaunch({ mode: "watch", repoRoot });
  child = spawn(launch.command, launch.args, {
    cwd: server,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", (error) => { spawnError = error; resolve(); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const boots = () => output.match(/BOOT \d+ [^\r\n]+/g) ?? [];
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 8_000;
    while (!predicate()) {
      assert.ifError(spawnError);
      assert.ok(child.exitCode === null && child.signalCode === null, `Watcher exited: ${output}`);
      assert.ok(Date.now() < deadline, `Timed out waiting for watcher: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await waitFor(() => boots().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (let i = 0; i < 3; i += 1) {
    await writeFile(path.join(sdk, "dist/index.js"), `export const value = 'build-${i}';\n`);
    await writeFile(path.join(sdk, "dist/testing.js"), `export const testValue = 'build-test-${i}';\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(boots().length, 1, `SDK builds restarted the watcher: ${output}`);
  assert.match(boots()[0], /source source-test$/);
  await writeFile(path.join(sdk, "src/testing.ts"), "export const testValue: string = 'updated-test';\n");
  await waitFor(() => boots().some((line) => line.endsWith("source updated-test")));
  assert.equal(boots().length, 2);
});

test("recovers a child that never becomes healthy after the startup grace period", async () => {
  const harness = createHarness();
  harness.setProbeError(new Error("connection refused"));

  await harness.watchdog.checkNow();
  harness.advance(99);
  await harness.watchdog.checkNow();
  assert.equal(harness.recoveries.length, 0);

  harness.advance(1);
  await harness.watchdog.checkNow();
  assert.deepEqual(harness.recoveries, ["startup_timeout"]);
});

test("recovers an unexpected watcher exit immediately and fails closed after bounded attempts", async () => {
  const harness = createHarness();

  await harness.watchdog.recoverNow("watch_process_exit");
  await harness.watchdog.recoverNow("watch_process_exit");
  await harness.watchdog.recoverNow("watch_process_exit");

  assert.deepEqual(harness.recoveries, ["watch_process_exit", "watch_process_exit"]);
  assert.equal(harness.failures.length, 1);
  assert.match(harness.failures[0].message, /recovery attempt limit/i);
});

test("a healthy probe resets the recovery-attempt budget", async () => {
  const harness = createHarness();

  await harness.watchdog.recoverNow("watch_process_exit");
  await harness.watchdog.recoverNow("watch_process_exit");
  await harness.watchdog.checkNow();
  await harness.watchdog.recoverNow("watch_process_exit");

  assert.equal(harness.recoveries.length, 3);
  assert.equal(harness.failures.length, 0);
});

test("server launch surfaces use the bounded default old-space ceiling", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../server/package.json", import.meta.url), "utf8"),
  );
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");

  for (const script of ["dev", "dev:watch", "start"]) {
    assert.match(packageJson.scripts[script], /--max-old-space-size=1536/);
  }
  assert.match(dockerfile, /"--max-old-space-size=1536"/);
});

test("watch mode directly owns the tsx watcher and carries the bounded heap flag", () => {
  const launch = createServerChildLaunch({
    mode: "watch",
    repoRoot: "/repo",
    platform: "darwin",
    forwardedArgs: ["--example"],
  });

  assert.equal(launch.command, "/repo/server/node_modules/.bin/tsx");
  assert.equal(launch.cwd, "/repo/server");
  assert.deepEqual(launch.args.slice(0, 2), ["watch", "--max-old-space-size=1536"]);
  assert.equal(launch.args.at(-1), "--example");
});

test("health identity rejects a different process on the configured port", () => {
  assert.doesNotThrow(() => assertServingChildHealth({ status: "ok", devWatchId: "watch-1" }, "watch-1"));
  assert.throws(
    () => assertServingChildHealth({ status: "ok", devWatchId: "watch-2" }, "watch-1"),
    /different process/i,
  );
  assert.throws(() => assertServingChildHealth({ status: "error" }, "watch-1"), /unhealthy/i);
});
