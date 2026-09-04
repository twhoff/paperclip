import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listCopilotCliModels,
  parseCopilotHelpConfigModels,
  resetCopilotModelsCacheForTests,
} from "./models.js";

const HELP_CONFIG_SNIPPET = `
Configuration Settings:

  \`allowedUrls\`: list of URLs or domains that are allowed to be accessed without prompting.

  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-sonnet-4.6"
    - "claude-sonnet-4.5"
    - "claude-haiku-4.5"
    - "claude-opus-4.7"
    - "claude-opus-4.6"
    - "claude-opus-4.6-fast"
    - "claude-opus-4.5"
    - "claude-sonnet-4"
    - "gpt-5.5"
    - "gpt-5.4"
    - "gpt-5.3-codex"
    - "gpt-5.2-codex"
    - "gpt-5.2"
    - "gpt-5.1"
    - "gpt-5.4-mini"
    - "gpt-5-mini"
    - "gpt-4.1"

  \`mouse\`: whether to enable mouse support in alt screen mode; defaults to \`true\`.
`;

describe("parseCopilotHelpConfigModels", () => {
  beforeEach(() => {
    resetCopilotModelsCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("extracts all model ids from help config output", () => {
    const models = parseCopilotHelpConfigModels(HELP_CONFIG_SNIPPET);
    expect(models.map((m) => m.id)).toEqual([
      "claude-sonnet-4.6",
      "claude-sonnet-4.5",
      "claude-haiku-4.5",
      "claude-opus-4.7",
      "claude-opus-4.6",
      "claude-opus-4.6-fast",
      "claude-opus-4.5",
      "claude-sonnet-4",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.2",
      "gpt-5.1",
      "gpt-5.4-mini",
      "gpt-5-mini",
      "gpt-4.1",
    ]);
  });

  it("uses the model id as the label", () => {
    const models = parseCopilotHelpConfigModels(HELP_CONFIG_SNIPPET);
    for (const m of models) {
      expect(m.label).toBe(m.id);
    }
  });

  it("stops at the next config key", () => {
    const models = parseCopilotHelpConfigModels(HELP_CONFIG_SNIPPET);
    // `mouse` section should not contribute any models
    expect(models.some((m) => m.id === "mouse")).toBe(false);
  });

  it("returns empty array for empty output", () => {
    expect(parseCopilotHelpConfigModels("")).toEqual([]);
  });

  it("returns empty array when model section is absent", () => {
    const noModel = `
  \`autoUpdate\`: whether to automatically download updated CLI versions.

  \`banner\`: frequency of showing animated banner.
`;
    expect(parseCopilotHelpConfigModels(noModel)).toEqual([]);
  });

  it("handles output with no trailing newline after last model", () => {
    const noTrailing = `  \`model\`: AI model to use...\n    - "gpt-5.4"\n    - "claude-sonnet-4.6"`;
    const models = parseCopilotHelpConfigModels(noTrailing);
    expect(models.map((m) => m.id)).toEqual(["gpt-5.4", "claude-sonnet-4.6"]);
  });

  it("skips empty or whitespace-only model ids", () => {
    const weird = `  \`model\`: AI model...\n    - ""\n    - "gpt-5.4"\n    - "  "\n`;
    const models = parseCopilotHelpConfigModels(weird);
    // Only "gpt-5.4" has content — empty string gets filtered, "  " trims to empty
    expect(models.map((m) => m.id)).not.toContain("");
    expect(models.some((m) => m.id === "gpt-5.4")).toBe(true);
  });

  it("keeps provider auth but strips injected control-plane identity from model discovery", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-copilot-model-env-"));
    const capturePath = path.join(tempDir, "env.json");
    const commandPath = path.join(tempDir, "copilot");
    const keys = [
      "PAPERCLIP_API_KEY",
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_TEST_OVERRIDE",
      "PCLI_SESSION_ID",
      "HOLLY_SESSION_ID",
      "GITHUB_TOKEN",
    ];

    await writeFile(
      commandPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const keys = ${JSON.stringify(keys)};
fs.writeFileSync(
  process.env.PROBE_CAPTURE_PATH,
  JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))),
);
process.stdout.write(${JSON.stringify(HELP_CONFIG_SNIPPET)});
`,
      "utf8",
    );
    await chmod(commandPath, 0o755);

    vi.stubEnv("PROBE_CAPTURE_PATH", capturePath);
    vi.stubEnv("PAPERCLIP_API_KEY", "ambient-run-token");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "jwt-signing-secret");
    vi.stubEnv("PAPERCLIP_TEST_OVERRIDE", "explicit-control-plane-value");
    vi.stubEnv("PCLI_SESSION_ID", "operator-session");
    vi.stubEnv("HOLLY_SESSION_ID", "operator-holly-session");
    vi.stubEnv("GITHUB_TOKEN", "github-provider-token");

    try {
      const models = await listCopilotCliModels(commandPath);
      const childEnv = JSON.parse(await readFile(capturePath, "utf8")) as Record<
        string,
        string | null
      >;

      expect(models.some((model) => model.id === "gpt-5.4")).toBe(true);
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
