import path from "node:path";

export const SERVER_MAX_OLD_SPACE_MB = 1536;

function asError(value, fallback) {
  if (value instanceof Error) return value;
  return new Error(value === undefined ? fallback : String(value));
}

export function createServerChildLaunch({
  mode,
  repoRoot,
  platform = process.platform,
  forwardedArgs = [],
}) {
  if (mode === "watch") {
    const serverDirectory = path.join(repoRoot, "server");
    return {
      command: path.join(
        serverDirectory,
        "node_modules",
        ".bin",
        platform === "win32" ? "tsx.cmd" : "tsx",
      ),
      args: [
        "watch",
        `--max-old-space-size=${SERVER_MAX_OLD_SPACE_MB}`,
        "--conditions=paperclip-dev",
        "--ignore",
        "../ui/node_modules",
        "--ignore",
        "../ui/.vite",
        "--ignore",
        "../ui/dist",
        "src/index.ts",
        ...forwardedArgs,
      ],
      cwd: serverDirectory,
    };
  }

  return {
    command: platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: ["--filter", "@paperclipai/server", "dev", ...forwardedArgs],
    cwd: repoRoot,
  };
}

export function assertServingChildHealth(payload, expectedWatchId) {
  if (!payload || typeof payload !== "object" || payload.status !== "ok") {
    throw new Error("Serving child reported an unhealthy status");
  }
  if (expectedWatchId && payload.devWatchId !== expectedWatchId) {
    throw new Error("Health endpoint belongs to a different process");
  }
  return payload;
}

export function createServingChildWatchdog({
  probe,
  recover,
  failClosed,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 2_500,
  startupGraceMs = 60_000,
  restartGraceMs = startupGraceMs,
  failureThreshold = 3,
  maxRecoveryAttempts = 3,
}) {
  if (typeof probe !== "function" || typeof recover !== "function" || typeof failClosed !== "function") {
    throw new TypeError("probe, recover, and failClosed are required functions");
  }

  let phase = "starting";
  let phaseStartedAt = now();
  let consecutiveFailures = 0;
  let failureStartedAt = null;
  let recoveryAttempts = 0;
  let interval = null;
  let stopped = false;
  let failed = false;
  let checkPromise = null;
  let recoveryPromise = null;

  async function closeOnFailure(error) {
    if (failed || stopped) return false;
    failed = true;
    phase = "failed";
    if (interval) {
      clearIntervalFn(interval);
      interval = null;
    }
    await failClosed(asError(error, "Serving child recovery failed"));
    return false;
  }

  async function recoverNow(reason) {
    if (stopped || failed) return false;
    if (recoveryPromise) return await recoveryPromise;

    recoveryPromise = (async () => {
      if (recoveryAttempts >= maxRecoveryAttempts) {
        return await closeOnFailure(
          new Error(`Serving child recovery attempt limit reached (${maxRecoveryAttempts})`),
        );
      }

      recoveryAttempts += 1;
      phase = "recovering";
      consecutiveFailures = 0;
      failureStartedAt = null;
      try {
        await recover(reason);
      } catch (error) {
        const cause = asError(error, "Serving child recovery failed");
        return await closeOnFailure(
          new Error(`Serving child recovery failed: ${cause.message}`, { cause }),
        );
      }

      phase = "starting";
      phaseStartedAt = now();
      return true;
    })();

    try {
      return await recoveryPromise;
    } finally {
      recoveryPromise = null;
    }
  }

  async function checkNow() {
    if (stopped || failed || recoveryPromise) return false;
    if (checkPromise) return await checkPromise;

    checkPromise = (async () => {
      try {
        await probe();
        phase = "healthy";
        consecutiveFailures = 0;
        failureStartedAt = null;
        recoveryAttempts = 0;
        return true;
      } catch {
        if (phase === "healthy") {
          failureStartedAt ??= now();
          consecutiveFailures += 1;
          // tsx owns normal source reloads. Allow its replacement server the
          // same startup window before treating the watcher as unavailable.
          if (consecutiveFailures >= failureThreshold && now() - failureStartedAt >= restartGraceMs) {
            await recoverNow("health_check_failed");
          }
          return false;
        }

        if (phase === "starting" && now() - phaseStartedAt >= startupGraceMs) {
          await recoverNow("startup_timeout");
        }
        return false;
      }
    })();

    try {
      return await checkPromise;
    } finally {
      checkPromise = null;
    }
  }

  function start() {
    if (stopped || failed || interval) return;
    phaseStartedAt = now();
    interval = setIntervalFn(() => {
      void checkNow();
    }, intervalMs);
    void checkNow();
  }

  function stop() {
    stopped = true;
    phase = "stopped";
    if (interval) {
      clearIntervalFn(interval);
      interval = null;
    }
  }

  return {
    checkNow,
    recoverNow,
    start,
    stop,
    state: () => ({
      phase,
      consecutiveFailures,
      recoveryAttempts,
      failed,
      stopped,
    }),
  };
}
