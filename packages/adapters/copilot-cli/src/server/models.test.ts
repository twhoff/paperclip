import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { parseCopilotHelpConfigModels, resetCopilotModelsCacheForTests } from "./models.js";

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
});
