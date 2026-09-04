import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listOzModels, testEnvironment } from "@paperclipai/adapter-oz-local/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listProfiles } from "../../../packages/adapters/oz-local/src/server/profiles.js";

const CAPTURE_KEYS = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_TEST_OVERRIDE",
  "PCLI_SESSION_ID",
  "HOLLY_SESSION_ID",
  "WARP_API_KEY",
];

type CapturedEnv = Record<(typeof CAPTURE_KEYS)[number], string | null>;

describe("oz provider probe environments", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("strips control-plane identity from model, profile, and environment probes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-oz-probe-env-"));
    const capturePath = path.join(tempDir, "env.ndjson");
    const commandPath = path.join(tempDir, "oz");

    await writeFile(
      commandPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const keys = ${JSON.stringify(CAPTURE_KEYS)};
const capture = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
fs.appendFileSync(process.env.PROBE_CAPTURE_PATH, JSON.stringify(capture) + "\\n");
const isProfileList = process.argv[2] === "agent";
process.stdout.write(JSON.stringify(
  isProfileList
    ? [{ id: "profile-secure", name: "Secure profile" }]
    : [{ id: "model-secure" }],
) + "\\n");
`,
      "utf8",
    );
    await chmod(commandPath, 0o755);

    vi.stubEnv("PROBE_CAPTURE_PATH", capturePath);
    vi.stubEnv("PAPERCLIP_API_KEY", "ambient-run-token");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "ambient-signing-secret");
    vi.stubEnv("PAPERCLIP_TEST_OVERRIDE", "ambient-control-plane-value");
    vi.stubEnv("PCLI_SESSION_ID", "ambient-operator-session");
    vi.stubEnv("HOLLY_SESSION_ID", "ambient-holly-session");
    vi.stubEnv("WARP_API_KEY", "warp-ambient-token");

    const explicitEnv = {
      PROBE_CAPTURE_PATH: capturePath,
      PAPERCLIP_API_KEY: "explicit-run-token",
      PAPERCLIP_AGENT_JWT_SECRET: "explicit-signing-secret",
      PAPERCLIP_TEST_OVERRIDE: "explicit-control-plane-value",
      PCLI_SESSION_ID: "explicit-operator-session",
      HOLLY_SESSION_ID: "explicit-holly-session",
      WARP_API_KEY: "warp-explicit-token",
    };

    try {
      const models = await listOzModels(commandPath);
      const profiles = await listProfiles(commandPath, explicitEnv);
      const environment = await testEnvironment({
        companyId: "company-1",
        adapterType: "oz_local",
        config: {
          command: commandPath,
          cwd: process.cwd(),
          env: explicitEnv,
        },
      });
      const captures = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CapturedEnv);

      expect(models.some((model) => model.id === "model-secure")).toBe(true);
      expect(profiles).toEqual([{ id: "profile-secure", name: "Secure profile" }]);
      expect(environment.checks.some((check) => check.code === "oz_probe_passed")).toBe(true);
      expect(captures).toHaveLength(3);
      expect(captures.map((capture) => capture.WARP_API_KEY)).toEqual([
        "warp-ambient-token",
        "warp-explicit-token",
        "warp-explicit-token",
      ]);
      for (const capture of captures) {
        expect(capture).toMatchObject({
          PAPERCLIP_API_KEY: null,
          PAPERCLIP_AGENT_JWT_SECRET: null,
          PAPERCLIP_TEST_OVERRIDE: null,
          PCLI_SESSION_ID: null,
          HOLLY_SESSION_ID: null,
        });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
