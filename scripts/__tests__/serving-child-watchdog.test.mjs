import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

  await harness.watchdog.checkNow();
  assert.deepEqual(harness.recoveries, ["health_check_failed"]);
  assert.equal(harness.failures.length, 0);
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
