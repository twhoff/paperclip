import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "oz");
  const cwd = asString(config.cwd, process.cwd());

  // Check 1: Working directory
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "oz_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "oz_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // Check 2: oz command in PATH
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "oz_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "oz_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "The oz CLI is bundled with the Warp desktop app. Ensure Warp is installed and oz is in your PATH.",
    });
  }

  // Check 3: WARP_API_KEY presence
  const configWarpApiKey = env.WARP_API_KEY;
  const hostWarpApiKey = process.env.WARP_API_KEY;
  if (isNonEmpty(configWarpApiKey) || isNonEmpty(hostWarpApiKey)) {
    const source = isNonEmpty(configWarpApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "oz_api_key_present",
      level: "info",
      message: "WARP_API_KEY is set.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "oz_api_key_missing",
      level: "info",
      message: "WARP_API_KEY not set. Oz will authenticate via the current `oz login` session.",
      hint: "If the probe fails with an auth error, set WARP_API_KEY in the adapter env or run `oz login`.",
    });
  }

  // Check 4: Connectivity probe — run oz model list
  const canRunProbe = checks.every(
    (c) => c.code !== "oz_cwd_invalid" && c.code !== "oz_command_unresolvable",
  );
  if (canRunProbe) {
    try {
      const probe = await runChildProcess(
        `oz-envtest-${Date.now()}`,
        command,
        ["model", "list", "--output-format", "json"],
        {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      if (probe.timedOut) {
        checks.push({
          code: "oz_probe_timed_out",
          level: "warn",
          message: "oz model list timed out.",
          hint: "Retry the probe. If this persists, check your network connection or Warp service status.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        // Parse the model list to get a count
        let modelCount = 0;
        try {
          const parsed = JSON.parse(probe.stdout.trim());
          if (Array.isArray(parsed)) modelCount = parsed.length;
        } catch {
          // ignore parse failure
        }
        checks.push({
          code: "oz_probe_passed",
          level: "info",
          message: `oz model list succeeded${modelCount > 0 ? ` (${modelCount} models available)` : ""}.`,
        });
      } else {
        const detail = (probe.stderr || probe.stdout).trim().slice(0, 240).replace(/\s+/g, " ");
        const isAuthError =
          /not\s+logged\s+in|please\s+log\s+in|unauthorized|authentication\s+required/i.test(
            probe.stdout + probe.stderr,
          );
        checks.push({
          code: isAuthError ? "oz_probe_auth_required" : "oz_probe_failed",
          level: "warn",
          message: isAuthError
            ? "oz is installed but authentication is not ready."
            : "oz model list failed.",
          ...(detail ? { detail } : {}),
          hint: isAuthError
            ? "Run `oz login` or set WARP_API_KEY in the adapter env, then retry the probe."
            : "Run `oz model list` manually to diagnose the issue.",
        });
      }
    } catch (err) {
      checks.push({
        code: "oz_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "oz model list probe failed unexpectedly",
        hint: "Run `oz model list` manually to diagnose the issue.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
