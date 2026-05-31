import { describe, expect, it } from "vitest";
import {
  CANONICAL_MODELS,
  CANONICAL_EFFORT_LEVELS,
  getAllowedEffortLevels,
  resolveCanonicalModel,
  resolveCanonicalEffort,
  translateEffort,
  translateModel,
} from "./canonical-models";

describe("Claude Opus 4.8 canonical model", () => {
  it("is registered with both base and 1M canonical keys", () => {
    expect(CANONICAL_MODELS["claude-opus-4.8"]).toBeDefined();
    expect(CANONICAL_MODELS["claude-opus-4.8-1m"]).toBeDefined();
  });

  it("reverse-resolves the copilot adapter model ids", () => {
    expect(resolveCanonicalModel("copilot_cli", "claude-opus-4.8")).toBe(
      "claude-opus-4.8",
    );
    expect(resolveCanonicalModel("copilot_cli", "claude-opus-4.8-1m")).toBe(
      "claude-opus-4.8-1m",
    );
  });

  it("translates to the claude_local kebab model id", () => {
    expect(translateModel("claude-opus-4.8", "claude_local")).toBe(
      "claude-opus-4-8",
    );
    expect(translateModel("claude-opus-4.8-1m", "claude_local")).toBe(
      "claude-opus-4-8",
    );
  });
});

describe("ultracode canonical effort level", () => {
  it("exists and maps only to claude_local", () => {
    const ultracode = CANONICAL_EFFORT_LEVELS["ultracode"];
    expect(ultracode).toBeDefined();
    expect(ultracode.adapters.claude_local).toEqual({
      field: "effort",
      value: "ultracode",
    });
    expect(ultracode.adapters.copilot_cli).toBeUndefined();
  });

  it("reverse-resolves from the claude_local effort value", () => {
    expect(resolveCanonicalEffort("claude_local", "ultracode")).toBe(
      "ultracode",
    );
  });

  it("translates straight through for claude_local", () => {
    expect(translateEffort("ultracode", "claude_local")).toEqual({
      field: "effort",
      value: "ultracode",
    });
  });

  it("degrades to high when switching to copilot_cli", () => {
    expect(translateEffort("ultracode", "copilot_cli")).toEqual({
      field: "effort",
      value: "high",
    });
  });
});

describe("allowed effort levels for Opus 4.8", () => {
  it("offers high/xhigh/max/ultracode on claude_local", () => {
    const levels = getAllowedEffortLevels("claude_local", "claude-opus-4.8");
    expect(levels).toContain("high");
    expect(levels).toContain("xhigh");
    expect(levels).toContain("max");
    expect(levels).toContain("ultracode");
  });

  it("caps at xhigh on copilot_cli (no max, no ultracode)", () => {
    const levels = getAllowedEffortLevels("copilot_cli", "claude-opus-4.8");
    expect(levels).toContain("xhigh");
    expect(levels).not.toContain("max");
    expect(levels).not.toContain("ultracode");
  });
});
