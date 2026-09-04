import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CAPTURE_BYTES,
  SensitiveValueStreamRedactor,
  finalizeLocalAdapterEnv,
  runningProcesses,
  runChildProcess,
  runLocalAdapterChildProcess,
  runProviderProbeChildProcess,
  stripLocalAdapterProviderEnv,
  terminateLocalAdapterProcess,
} from "./server-utils.js";

const CONTROL_PLANE_ENV = {
  PAPERCLIP_AGENT_JWT_SECRET: "jwt-signing-secret-control-plane",
  DATABASE_URL: "postgres://control:plane@localhost/paperclip",
  BETTER_AUTH_SECRET: "better-auth-control-plane-secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "master-key-control-plane-secret",
  PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/private/control-plane-master-key",
} as const;

const controlPlanePresenceScript = `
const keys = ${JSON.stringify(Object.keys(CONTROL_PLANE_ENV))};
const result = Object.fromEntries(keys.map((key) => [key, Object.hasOwn(process.env, key)]));
result.providerPreserved = process.env.PROVIDER_API_KEY === "provider-secret-value";
result.userPreserved = process.env.USER_PREFERENCE === "keep-me";
process.stdout.write(JSON.stringify(result));
`;

function processOptions(
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> = async () => {},
) {
  return {
    cwd: process.cwd(),
    env: {
      ...CONTROL_PLANE_ENV,
      PROVIDER_API_KEY: "provider-secret-value",
      USER_PREFERENCE: "keep-me",
    },
    timeoutSec: 5,
    graceSec: 1,
    onLog,
  };
}

describe("local child process security boundary", () => {
  it("redacts a long near-match in linear streaming work", () => {
    const prefixLength = 64 * 1024 - 1;
    const redactor = new SensitiveValueStreamRedactor([`${"a".repeat(prefixLength)}b`]);
    const startedAt = performance.now();
    let output = "";

    for (let index = 0; index < prefixLength; index += 1) {
      output += redactor.push("a");
    }
    output += redactor.flush();

    expect(output).toBe("***REDACTED***");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("fails closed when the configured secret matcher budget is exceeded", () => {
    const redactor = new SensitiveValueStreamRedactor(
      Array.from({ length: 129 }, (_, index) => `provider-secret-${index}`),
    );

    expect(redactor.push("ordinary child output")).toBe("***REDACTED***");
    expect(redactor.push("more output")).toBe("");
    expect(redactor.flush()).toBe("");
  });

  it("strips Paperclip runtime identity from provider CLI probes while preserving provider auth", () => {
    const sanitized = stripLocalAdapterProviderEnv({
      ...CONTROL_PLANE_ENV,
      PAPERCLIP_API_KEY: "paperclip-run-token",
      PAPERCLIP_AGENT_ID: "agent-id",
      PAPERCLIP_COMPANY_ID: "company-id",
      PAPERCLIP_RUN_ID: "run-id",
      PAPERCLIP_TASK_ID: "task-id",
      PAPERCLIP_API_URL: "http://paperclip.invalid",
      PAPERCLIP_ADAPTER_TYPE: "codex_local",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_FUTURE_RUNTIME_FIELD: "must-not-cross-provider-boundary",
      PCLI_SESSION_ID: "legacy-session",
      HOLLY_SESSION_ID: "agent-session",
      ANTHROPIC_API_KEY: "anthropic-provider-token",
      OPENAI_API_KEY: "openai-provider-token",
      GH_TOKEN: "github-provider-token",
      USER_PREFERENCE: "keep-me",
    });

    expect(sanitized).toEqual({
      ANTHROPIC_API_KEY: "anthropic-provider-token",
      OPENAI_API_KEY: "openai-provider-token",
      GH_TOKEN: "github-provider-token",
      USER_PREFERENCE: "keep-me",
    });
  });

  it("enforces the provider probe boundary after explicit env overrides", async () => {
    const paperclipKeys = [
      ...Object.keys(CONTROL_PLANE_ENV),
      "PAPERCLIP_API_KEY",
      "PAPERCLIP_AGENT_ID",
      "PAPERCLIP_COMPANY_ID",
      "PAPERCLIP_RUN_ID",
      "PAPERCLIP_TASK_ID",
      "PAPERCLIP_API_URL",
      "PAPERCLIP_ADAPTER_TYPE",
      "PAPERCLIP_FUTURE_RUNTIME_FIELD",
      "PCLI_SESSION_ID",
      "HOLLY_SESSION_ID",
    ];
    const providerSecret = "provider-probe-secret-value";
    const strippedSecret = CONTROL_PLANE_ENV.PAPERCLIP_AGENT_JWT_SECRET;
    const script = `
const keys = ${JSON.stringify(paperclipKeys)};
const result = Object.fromEntries(keys.map((key) => [key, Object.hasOwn(process.env, key)]));
result.providerPreserved = process.env.OPENAI_API_KEY === ${JSON.stringify(providerSecret)};
result.userPreserved = process.env.USER_PREFERENCE === "keep-me";
process.stdout.write(JSON.stringify(result));
process.stderr.write(${JSON.stringify(strippedSecret)} + ":" + process.env.OPENAI_API_KEY);
`;
    const streamed: string[] = [];

    const result = await runProviderProbeChildProcess(
      "provider-probe-env-boundary",
      process.execPath,
      ["-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...CONTROL_PLANE_ENV,
          PAPERCLIP_API_KEY: "explicit-spoofed-paperclip-token",
          PAPERCLIP_AGENT_ID: "explicit-spoofed-agent",
          PAPERCLIP_COMPANY_ID: "explicit-spoofed-company",
          PAPERCLIP_RUN_ID: "explicit-spoofed-run",
          PAPERCLIP_TASK_ID: "explicit-spoofed-task",
          PAPERCLIP_API_URL: "http://paperclip.invalid",
          PAPERCLIP_ADAPTER_TYPE: "explicit-spoofed-adapter",
          PAPERCLIP_FUTURE_RUNTIME_FIELD: "explicit-spoofed-future-field",
          PCLI_SESSION_ID: "explicit-spoofed-pcli-session",
          HOLLY_SESSION_ID: "explicit-spoofed-holly-session",
          OPENAI_API_KEY: providerSecret,
          USER_PREFERENCE: "keep-me",
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async (stream, chunk) => {
          if (stream === "stderr") streamed.push(chunk);
        },
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      ...Object.fromEntries(paperclipKeys.map((key) => [key, false])),
      providerPreserved: true,
      userPreserved: true,
    });
    expect(result.stderr).toBe("***REDACTED***:***REDACTED***");
    expect(streamed.join("")).toBe(result.stderr);
  });

  it("strips control-plane secrets after the final local env merge while preserving provider and user env", async () => {
    const result = await runLocalAdapterChildProcess(
      {
        id: "00000000-0000-4000-8000-000000000001",
        companyId: "company-1",
        adapterType: "codex_local",
      },
      "local-env-boundary",
      process.execPath,
      ["-e", controlPlanePresenceScript],
      processOptions(),
    );

    expect(JSON.parse(result.stdout)).toEqual({
      PAPERCLIP_AGENT_JWT_SECRET: false,
      DATABASE_URL: false,
      BETTER_AUTH_SECRET: false,
      PAPERCLIP_SECRETS_MASTER_KEY: false,
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: false,
      providerPreserved: true,
      userPreserved: true,
    });
  });

  it("passes exactly one trusted uppercase Holly identity to a real local child", async () => {
    const trustedSessionId = "agent-00000000-0000-4000-8000-000000000001";
    const script = `
const sessionEntries = Object.entries(process.env)
  .filter(([key]) => ["PCLI_SESSION_ID", "HOLLY_SESSION_ID"].includes(key.toUpperCase()))
  .sort(([left], [right]) => left.localeCompare(right));
process.stdout.write(JSON.stringify(sessionEntries));
`;
    const result = await runLocalAdapterChildProcess(
      {
        id: "00000000-0000-4000-8000-000000000001",
        companyId: "company-1",
        adapterType: "codex_local",
      },
      "mixed-case-local-session-boundary",
      process.execPath,
      ["-e", script],
      {
        ...processOptions(),
        env: {
          ...processOptions().env,
          pClI_sEsSiOn_Id: "untrusted-pcli-session",
          hOlLy_SeSsIoN_iD: "untrusted-holly-session",
        },
      },
    );

    expect(JSON.parse(result.stdout)).toEqual([["HOLLY_SESSION_ID", trustedSessionId]]);
  });

  it("passes exactly one trusted uppercase Paperclip API key to a real local child", async () => {
    const inheritedKey = "paperclip_api_key";
    const previousInherited = process.env[inheritedKey];
    const trustedApiKey = "trusted-run-api-key";
    const script = `
const apiKeyEntries = Object.entries(process.env)
  .filter(([key]) => key.toUpperCase() === "PAPERCLIP_API_KEY")
  .map(([key, value]) => [key, value === ${JSON.stringify(trustedApiKey)}])
  .sort(([left], [right]) => left.localeCompare(right));
process.stdout.write(JSON.stringify(apiKeyEntries));
`;
    process.env[inheritedKey] = "untrusted-inherited-api-key";

    try {
      const result = await runLocalAdapterChildProcess(
        {
          id: "00000000-0000-4000-8000-000000000001",
          companyId: "company-1",
          adapterType: "codex_local",
        },
        "mixed-case-paperclip-api-key-boundary",
        process.execPath,
        ["-e", script],
        {
          ...processOptions(),
          env: {
            ...processOptions().env,
            PAPERCLIP_API_KEY: trustedApiKey,
            PaPeRcLiP_aPi_KeY: "untrusted-configured-api-key",
          },
        },
      );

      expect(JSON.parse(result.stdout)).toEqual([["PAPERCLIP_API_KEY", true]]);
    } finally {
      if (previousInherited === undefined) delete process.env[inheritedKey];
      else process.env[inheritedKey] = previousInherited;
    }
  });

  it("strips mixed-case Claude nesting guards from a real child", async () => {
    const script = `
const nestingKeys = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
]);
process.stdout.write(JSON.stringify(
  Object.keys(process.env).filter((key) => nestingKeys.has(key.toUpperCase())),
));
`;
    const result = await runLocalAdapterChildProcess(
      {
        id: "00000000-0000-4000-8000-000000000001",
        companyId: "company-1",
        adapterType: "claude_local",
      },
      "mixed-case-claude-nesting-boundary",
      process.execPath,
      ["-e", script],
      {
        ...processOptions(),
        env: {
          ...processOptions().env,
          cLaUdEcOdE: "1",
          cLaUdE_cOdE_sEsSiOn: "nested-session",
        },
      },
    );

    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("rejects configured local session identity using any key casing", () => {
    const agent = {
      id: "00000000-0000-4000-8000-000000000001",
      companyId: "company-1",
      adapterType: "codex_local",
    };

    expect(() =>
      finalizeLocalAdapterEnv(agent, {}, { pClI_sEsSiOn_Id: "untrusted-pcli-session" }),
    ).toThrow("PCLI_SESSION_ID must not be configured for local adapters");
    expect(() =>
      finalizeLocalAdapterEnv(agent, {}, { hOlLy_SeSsIoN_iD: "agent-another-agent" }),
    ).toThrow("Configured HOLLY_SESSION_ID does not match the local agent session identity");
  });

  it.each([
    ["PAPERCLIP_API_KEY", "configured-token"],
    ["PAPERCLIP_API_URL", "https://attacker.invalid"],
    ["paperclip_api_url", "https://attacker.invalid"],
    ["PaPeRcLiP_aGeNt_Id", "another-agent"],
  ])("rejects configured runtime authority key %s", (key, value) => {
    const agent = {
      id: "00000000-0000-4000-8000-000000000001",
      companyId: "company-1",
      adapterType: "codex_local",
    };

    expect(() => finalizeLocalAdapterEnv(agent, {}, { [key]: value })).toThrow(
      "runtime-owned and must not be configured",
    );
  });

  it("normalizes a matching configured Holly identity to one trusted uppercase key", () => {
    const agent = {
      id: "00000000-0000-4000-8000-000000000001",
      companyId: "company-1",
      adapterType: "codex_local",
    };
    const trustedSessionId = `agent-${agent.id}`;
    const env = {
      pClI_sEsSiOn_Id: "untrusted-pcli-session",
      hOlLy_SeSsIoN_iD: trustedSessionId,
      HOLLY_SESSION_ID: "stale-uppercase-session",
    };

    finalizeLocalAdapterEnv(agent, env, { hOlLy_SeSsIoN_iD: trustedSessionId });

    expect(
      Object.entries(env).filter(([key]) =>
        ["PCLI_SESSION_ID", "HOLLY_SESSION_ID"].includes(key.toUpperCase()),
      ),
    ).toEqual([["HOLLY_SESSION_ID", trustedSessionId]]);
  });

  it("secures generic local callers by default even when adapter identity is spoofed", async () => {
    const script = `
const result = {
  signingSecret: Object.hasOwn(process.env, "PAPERCLIP_AGENT_JWT_SECRET"),
  pcliSession: Object.hasOwn(process.env, "PCLI_SESSION_ID"),
  hollySession: Object.hasOwn(process.env, "HOLLY_SESSION_ID"),
};
process.stdout.write(JSON.stringify(result));
`;
    const localResult = await runChildProcess(
      "copilot-env-boundary",
      process.execPath,
      ["-e", script],
      {
        ...processOptions(),
        env: {
          ...processOptions().env,
          PAPERCLIP_ADAPTER_TYPE: "spoofed-by-config",
          PCLI_SESSION_ID: "spoofed-pcli-session",
          HOLLY_SESSION_ID: "agent-spoofed-holly-session",
        },
      },
    );

    expect(JSON.parse(localResult.stdout)).toEqual({
      signingSecret: false,
      pcliSession: false,
      hollySession: false,
    });
  });

  it("drops an ambient Paperclip API key but preserves a scoped run token", async () => {
    const previous = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "ambient-board-token-value";
    const script =
      "process.stdout.write(process.env.PAPERCLIP_API_KEY ? 'present:' + process.env.PAPERCLIP_API_KEY : 'absent')";

    try {
      const inherited = await runChildProcess(
        "ambient-paperclip-key",
        process.execPath,
        ["-e", script],
        {
          ...processOptions(),
          env: processOptions().env,
        },
      );
      const scoped = await runChildProcess(
        "scoped-paperclip-key",
        process.execPath,
        ["-e", script],
        {
          ...processOptions(),
          env: {
            ...processOptions().env,
            PAPERCLIP_API_KEY: "scoped-run-token-value",
          },
        },
      );

      expect(inherited.stdout).toBe("absent");
      expect(scoped.stdout).toBe("present:***REDACTED***");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previous;
    }
  });

  it("redacts sensitive env values from streamed and captured output across chunk boundaries", async () => {
    const providerSecret = "provider-value-9d63b25e";
    const runtimeToken = "runtime-token-a83c4d76";
    const strippedDatabaseUrl = CONTROL_PLANE_ENV.DATABASE_URL;
    const script = `
const stdoutSecret = process.env.PROVIDER_API_KEY;
const stderrSecret = process.env.PAPERCLIP_API_KEY;
const strippedSecret = ${JSON.stringify(strippedDatabaseUrl)};
const writes = [
  [process.stdout, "ordinary-out:"],
  [process.stdout, stdoutSecret.slice(0, 9)],
  [process.stdout, stdoutSecret.slice(9) + ":out-end\\n"],
  [process.stderr, "ordinary-err:"],
  [process.stderr, stderrSecret.slice(0, 7)],
  [process.stderr, stderrSecret.slice(7) + ":" + strippedSecret.slice(0, 12)],
  [process.stderr, strippedSecret.slice(12) + ":err-end\\n"],
];
let index = 0;
const writeNext = () => {
  if (index === writes.length) return;
  const [stream, value] = writes[index++];
  stream.write(value);
  setTimeout(writeNext, 20);
};
writeNext();
`;
    const streamed = { stdout: [] as string[], stderr: [] as string[] };

    const result = await runChildProcess(
      "redacted-local-output",
      process.execPath,
      ["-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...CONTROL_PLANE_ENV,
          PROVIDER_API_KEY: providerSecret,
          PAPERCLIP_API_KEY: runtimeToken,
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async (stream, chunk) => {
          streamed[stream].push(chunk);
        },
      },
    );

    const expectedStdout = "ordinary-out:***REDACTED***:out-end\n";
    const expectedStderr =
      "ordinary-err:***REDACTED***:***REDACTED***:err-end\n";
    expect(result.stdout).toBe(expectedStdout);
    expect(result.stderr).toBe(expectedStderr);
    expect(streamed.stdout.join("")).toBe(expectedStdout);
    expect(streamed.stderr.join("")).toBe(expectedStderr);
    expect(streamed.stdout[0]).toBe("ordinary-out:");
    expect(streamed.stderr[0]).toBe("ordinary-err:");
  });

  it("keeps the bounded stderr prefix so a truncated failure cannot hide a generic token start", async () => {
    const historicalJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoaXN0b3JpYyJ9.signature";
    const failurePrefix = "failure:";
    const trailingBytes = MAX_CAPTURE_BYTES - Buffer.byteLength(historicalJwt, "utf8") + 1;
    const script = `
const token = ${JSON.stringify(historicalJwt)};
process.stderr.write(${JSON.stringify(failurePrefix)} + token + "x".repeat(${trailingBytes}));
process.exitCode = 1;
`;

    const result = await runChildProcess(
      "bounded-failure-result",
      process.execPath,
      ["-e", script],
      processOptions(),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toHaveLength(MAX_CAPTURE_BYTES);
    expect(result.stderr.includes(`${failurePrefix}${historicalJwt}`)).toBe(true);
    expect(result.stderr.startsWith(historicalJwt.slice(1))).toBe(false);
  });

  it("redacts a complete secret before an overlapping partial secret prefix", async () => {
    const script = `
process.stdout.write(process.env.FIRST_API_KEY + "X");
setTimeout(() => process.stdout.write("q"), 20);
`;
    const streamed: string[] = [];

    const result = await runChildProcess(
      "overlapping-local-output",
      process.execPath,
      ["-e", script],
      {
        cwd: process.cwd(),
        env: {
          FIRST_API_KEY: "abcdef",
          SECOND_API_KEY: "defXYZ",
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async (_stream, chunk) => {
          streamed.push(chunk);
        },
      },
    );

    expect(result.stdout).toBe("***REDACTED***Xq");
    expect(streamed.join("")).toBe(result.stdout);
  });

  it("fails closed when a secret is split across ordered stdout and stderr writes", async () => {
    const providerSecret = "abcdef";
    const script = `
process.stdout.write("abc");
setTimeout(() => {
  process.stderr.write("def");
  setTimeout(() => process.stdout.write("x"), 20);
}, 20);
`;
    const streamed = { stdout: [] as string[], stderr: [] as string[] };

    const result = await runChildProcess(
      "unfinished-secret-prefix",
      process.execPath,
      ["-e", script],
      {
        cwd: process.cwd(),
        env: {
          PROVIDER_API_KEY: providerSecret,
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async (stream, chunk) => {
          streamed[stream].push(chunk);
        },
      },
    );

    expect(result.stdout).toBe("***REDACTED***x");
    expect(result.stderr).toBe("def");
    expect(result.stdout + result.stderr).not.toContain(providerSecret);
    expect(streamed.stdout.join("")).toBe(result.stdout);
    expect(streamed.stderr.join("")).toBe(result.stderr);
  });

  it("omits secret-bearing callback failures from the default console warning", async () => {
    const credential = "callback-failure-secret-1d52";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runChildProcess(
        "callback-log-failure",
        process.execPath,
        ["-e", "process.stdout.write('safe output')"],
        {
          ...processOptions(),
          env: { PROVIDER_API_KEY: credential },
          onLog: async () => {
            throw new Error(`failed with ${credential}`);
          },
        },
      );

      expect(result.stdout).toBe("safe output");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(credential);
      expect(warn).toHaveBeenCalledWith("failed to append stdout log chunk");
    } finally {
      warn.mockRestore();
    }
  });

  it("escalates a timed-out child that ignores SIGTERM to SIGKILL", async () => {
    const result = await runProviderProbeChildProcess(
      "ignored-sigterm",
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      {
        ...processOptions(),
        timeoutSec: 0.2,
        graceSec: 1,
      },
    );

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it.skipIf(process.platform === "win32")(
    "terminates the process group when a timed-out child has a SIGTERM-resistant descendant",
    async () => {
      const grandchildScript = "process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)";
      const parentScript = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {
  stdio: ["ignore", "pipe", "ignore"],
});
grandchild.stdout.once("data", () => process.stdout.write(String(grandchild.pid)));
setInterval(() => {}, 1000);
`;
      let grandchildPid: number | null = null;

      try {
        const result = await runProviderProbeChildProcess(
          "ignored-sigterm-process-tree",
          process.execPath,
          ["-e", parentScript],
          {
            ...processOptions(),
            // Give the nested Node process enough time to report readiness on
            // loaded CI hosts before exercising the timeout path.
            timeoutSec: 3,
            graceSec: 0.2,
          },
        );
        grandchildPid = Number.parseInt(result.stdout, 10);

        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGTERM");
        expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
        expect(() => process.kill(grandchildPid!, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        if (grandchildPid && grandchildPid > 0) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // The process-group implementation should already have reaped it.
          }
        }
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "registers the process group before onSpawn so a late abort terminates its descendant",
    async () => {
      const runId = "late-abort-process-tree";
      const controller = new AbortController();
      const grandchildScript = "process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)";
      const parentScript = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {
  stdio: ["ignore", "pipe", "ignore"],
});
grandchild.stdout.once("data", () => process.stdout.write(String(grandchild.pid)));
setInterval(() => {}, 1000);
`;
      let resolveSpawned!: () => void;
      let resolveGrandchildReady!: () => void;
      const spawned = new Promise<void>((resolve) => {
        resolveSpawned = resolve;
      });
      const grandchildReady = new Promise<void>((resolve) => {
        resolveGrandchildReady = resolve;
      });
      let registeredBeforeCallback = false;
      let grandchildPid: number | null = null;

      try {
        const resultPromise = runProviderProbeChildProcess(
          runId,
          process.execPath,
          ["-e", parentScript],
          {
            ...processOptions(async (stream, chunk) => {
              if (stream === "stdout" && /^\d+$/.test(chunk)) {
                grandchildPid = Number.parseInt(chunk, 10);
                resolveGrandchildReady();
              }
            }),
            timeoutSec: 5,
            graceSec: 1,
            signal: controller.signal,
            onSpawn: async ({ pid }) => {
              registeredBeforeCallback = runningProcesses.get(runId)?.child.pid === pid;
              resolveSpawned();
            },
          },
        );

        await Promise.all([spawned, grandchildReady]);
        controller.abort();
        const result = await resultPromise;

        expect(registeredBeforeCallback).toBe(true);
        expect(result.signal).toBe("SIGKILL");
        const confirmedGrandchildPid = grandchildPid;
        if (confirmedGrandchildPid === null) throw new Error("grandchild pid was not captured");
        expect(Number.isInteger(confirmedGrandchildPid) && confirmedGrandchildPid > 0).toBe(true);
        expect(() => process.kill(confirmedGrandchildPid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        controller.abort();
        if (grandchildPid && grandchildPid > 0) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // The process-group implementation should already have reaped it.
          }
        }
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "fails closed and retains tracking when process-group termination cannot be proven",
    async () => {
      const runId = "unproven-process-tree-termination";
      const originalKill = process.kill.bind(process);
      let childPid: number | null = null;
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === 0) return true;
        return originalKill(pid, signal);
      }) as typeof process.kill);

      try {
        const resultPromise = runProviderProbeChildProcess(
          runId,
          process.execPath,
          ["-e", "setInterval(()=>{},1000)"],
          {
            ...processOptions(),
            timeoutSec: 0.05,
            graceSec: 0,
            onSpawn: async ({ pid }) => {
              childPid = pid;
            },
          },
        );

        await expect(resultPromise).rejects.toMatchObject({
          code: "process_termination_pending",
          processTerminationPending: true,
        });
        expect(childPid).not.toBeNull();
        expect(runningProcesses.get(runId)?.child.pid).toBe(childPid);
      } finally {
        killSpy.mockRestore();
        const tracked = runningProcesses.get(runId);
        if (tracked) {
          await terminateLocalAdapterProcess(tracked.child, {
            processGroup: tracked.processGroup,
            graceMs: 100,
            killWaitMs: 1_000,
          });
          runningProcesses.delete(runId);
        }
      }
    },
    7_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps the pending contract when a child error races unproven termination",
    async () => {
      const runId = "child-error-unproven-termination";
      const originalKill = process.kill.bind(process);
      let spawnedChild: ChildProcess | null = null;
      let resolveSpawned!: () => void;
      const spawned = new Promise<void>((resolve) => {
        resolveSpawned = resolve;
      });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === 0) return true;
        return originalKill(pid, signal);
      }) as typeof process.kill);

      try {
        const resultPromise = runProviderProbeChildProcess(
          runId,
          process.execPath,
          ["-e", "setInterval(()=>{},1000)"],
          {
            ...processOptions(),
            timeoutSec: 5,
            graceSec: 0,
            onSpawn: async () => {
              spawnedChild = runningProcesses.get(runId)?.child ?? null;
              resolveSpawned();
            },
          },
        );

        await spawned;
        spawnedChild!.emit("error", new Error("simulated child kill failure"));
        await expect(resultPromise).rejects.toMatchObject({
          code: "process_termination_pending",
          processTerminationPending: true,
        });
        expect(runningProcesses.get(runId)?.child).toBe(spawnedChild);
      } finally {
        killSpy.mockRestore();
        const tracked = runningProcesses.get(runId);
        const child = tracked?.child ?? spawnedChild;
        if (child) {
          await terminateLocalAdapterProcess(child, {
            processGroup: tracked?.processGroup ?? true,
            graceMs: 100,
            killWaitMs: 1_000,
          });
        }
        runningProcesses.delete(runId);
      }
    },
    7_000,
  );

  it("terminates a provider probe when its caller aborts", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 100);

    const result = await runProviderProbeChildProcess(
      "aborted-provider-probe",
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {
        ...processOptions(),
        timeoutSec: 2,
        graceSec: 1,
        signal: controller.signal,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.signal).toBe("SIGTERM");
    expect(runningProcesses.has("aborted-provider-probe")).toBe(false);
  });
});
