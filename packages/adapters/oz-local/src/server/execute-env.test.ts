import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@paperclipai/adapter-utils/server-utils")
  >();
  return {
    ...actual,
    listPaperclipSkillEntries: vi.fn(async () => []),
  };
});

import { execute } from "./execute.js";

const trackedEnvKeys = [
  "OPENAI_API_KEY",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_REASON",
] as const;
const originalEnv = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof trackedEnvKeys)[number], string | undefined>;

afterEach(() => {
  for (const key of trackedEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function createEnvironmentReporter() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-oz-env-"));
  const executable = path.join(directory, "report-env");
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
process.stderr.write(JSON.stringify({
  providerAuthSurvives: process.env.OPENAI_API_KEY === "provider-auth-survives",
  paperclipApiKeyAbsent: process.env.PAPERCLIP_API_KEY === undefined,
  agentId: process.env.PAPERCLIP_AGENT_ID ?? null,
  companyId: process.env.PAPERCLIP_COMPANY_ID ?? null,
  runId: process.env.PAPERCLIP_RUN_ID ?? null,
  taskIdAbsent: process.env.PAPERCLIP_TASK_ID === undefined,
  wakeReasonAbsent: process.env.PAPERCLIP_WAKE_REASON === undefined,
}));
`,
    "utf8",
  );
  await fs.chmod(executable, 0o755);
  return { directory, executable };
}

describe("Oz local child environment authority", () => {
  it("does not promote stale ambient Paperclip values into the trusted child env", async () => {
    process.env.OPENAI_API_KEY = "provider-auth-survives";
    process.env.PAPERCLIP_API_KEY = "stale-control-plane-key";
    process.env.PAPERCLIP_TASK_ID = "stale-task-id";
    process.env.PAPERCLIP_WAKE_REASON = "stale-wake-reason";
    const { directory, executable } = await createEnvironmentReporter();
    const context: AdapterExecutionContext = {
      runId: "current-run-id",
      agent: {
        id: "current-agent-id",
        companyId: "current-company-id",
        name: "Environment Test Agent",
        adapterType: "oz_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { command: executable, cwd: directory, profile: "test-profile" },
      context: {},
      onLog: async () => undefined,
    };

    try {
      const result = await execute(context);
      const stderr = (result.resultJson as { stderr?: unknown } | null)?.stderr;
      expect(typeof stderr).toBe("string");
      expect(JSON.parse(stderr as string)).toMatchObject({
        providerAuthSurvives: true,
        paperclipApiKeyAbsent: true,
        agentId: "current-agent-id",
        companyId: "current-company-id",
        runId: "current-run-id",
        taskIdAbsent: true,
        wakeReasonAbsent: true,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
