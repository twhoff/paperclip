import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { listAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads codex models dynamically and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-spark")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAdapterModels("cursor");
    const second = await listAdapterModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
  });

  it("keeps Cursor auth but strips control-plane identity in default CLI discovery", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-model-env-"));
    const capturePath = path.join(tempDir, "env.json");
    const commandPath = path.join(tempDir, "agent");
    const keys = [
      "PAPERCLIP_API_KEY",
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_TEST_OVERRIDE",
      "PCLI_SESSION_ID",
      "HOLLY_SESSION_ID",
      "CURSOR_API_KEY",
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
process.stdout.write("Available models: secure-cursor-model\\n");
`,
      "utf8",
    );
    await chmod(commandPath, 0o755);

    vi.stubEnv("PATH", `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("PROBE_CAPTURE_PATH", capturePath);
    vi.stubEnv("PAPERCLIP_API_KEY", "ambient-run-token");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "ambient-signing-secret");
    vi.stubEnv("PAPERCLIP_TEST_OVERRIDE", "ambient-control-plane-value");
    vi.stubEnv("PCLI_SESSION_ID", "operator-session");
    vi.stubEnv("HOLLY_SESSION_ID", "operator-holly-session");
    vi.stubEnv("CURSOR_API_KEY", "cursor-provider-token");

    try {
      const models = await listAdapterModels("cursor");
      const childEnv = JSON.parse(await readFile(capturePath, "utf8")) as Record<
        string,
        string | null
      >;

      expect(models.some((model) => model.id === "secure-cursor-model")).toBe(true);
      expect(childEnv).toEqual({
        PAPERCLIP_API_KEY: null,
        PAPERCLIP_AGENT_JWT_SECRET: null,
        PAPERCLIP_TEST_OVERRIDE: null,
        PCLI_SESSION_ID: null,
        HOLLY_SESSION_ID: null,
        CURSOR_API_KEY: "cursor-provider-token",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns no opencode models when opencode command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");
    expect(models).toEqual([]);
  });
});
