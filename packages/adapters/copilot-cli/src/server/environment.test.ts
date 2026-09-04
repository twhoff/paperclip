import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

const CONTROL_PLANE_KEYS = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_TEST_OVERRIDE",
  "PCLI_SESSION_ID",
  "HOLLY_SESSION_ID",
  "GITHUB_TOKEN",
];

describe("copilot provider probe environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps provider auth but strips explicit and ambient control-plane identity", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-copilot-probe-env-"));
    const capturePath = path.join(tempDir, "env.json");
    const commandPath = path.join(tempDir, "copilot");

    await writeFile(
      commandPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const keys = ${JSON.stringify(CONTROL_PLANE_KEYS)};
fs.writeFileSync(
  process.env.PROBE_CAPTURE_PATH,
  JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))),
);
process.stdout.write(JSON.stringify({
  type: "assistant.message",
  data: { messageId: "probe-message", content: "hello", toolRequests: [] },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  sessionId: "provider-probe-session",
  exitCode: 0,
  usage: {},
}) + "\\n");
`,
      "utf8",
    );
    await chmod(commandPath, 0o755);

    vi.stubEnv("PAPERCLIP_API_KEY", "ambient-run-token");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "ambient-signing-secret");
    vi.stubEnv("PAPERCLIP_TEST_OVERRIDE", "ambient-control-plane-value");
    vi.stubEnv("PCLI_SESSION_ID", "ambient-operator-session");
    vi.stubEnv("HOLLY_SESSION_ID", "ambient-holly-session");

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "copilot_cli",
        config: {
          command: commandPath,
          cwd: process.cwd(),
          env: {
            PROBE_CAPTURE_PATH: capturePath,
            PAPERCLIP_API_KEY: "explicit-run-token",
            PAPERCLIP_AGENT_JWT_SECRET: "explicit-signing-secret",
            PAPERCLIP_TEST_OVERRIDE: "explicit-control-plane-value",
            PCLI_SESSION_ID: "explicit-operator-session",
            HOLLY_SESSION_ID: "explicit-holly-session",
            GITHUB_TOKEN: "github-provider-token",
          },
        },
      });
      const childEnv = JSON.parse(await readFile(capturePath, "utf8")) as Record<
        string,
        string | null
      >;

      expect(result.checks.some((check) => check.code === "copilot_hello_probe_passed")).toBe(
        true,
      );
      expect(childEnv).toEqual({
        PAPERCLIP_API_KEY: null,
        PAPERCLIP_AGENT_JWT_SECRET: null,
        PAPERCLIP_TEST_OVERRIDE: null,
        PCLI_SESSION_ID: null,
        HOLLY_SESSION_ID: null,
        GITHUB_TOKEN: "github-provider-token",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
