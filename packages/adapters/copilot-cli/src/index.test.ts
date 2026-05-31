import { describe, expect, it } from "vitest";
import { models, modelEffortSupport } from "./index.js";

describe("copilot_cli model catalogue", () => {
  it("offers Claude Opus 4.8 (base + 1M) in the static model list", () => {
    const ids = models.map((m) => m.id);
    expect(ids).toContain("claude-opus-4.8");
    expect(ids).toContain("claude-opus-4.8-1m");
  });

  it("supports reasoning effort up to xhigh for Opus 4.8", () => {
    expect(modelEffortSupport["claude-opus-4.8"]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(modelEffortSupport["claude-opus-4.8-1m"]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("never exposes max or ultracode (those are claude_local only)", () => {
    for (const levels of Object.values(modelEffortSupport)) {
      expect(levels).not.toContain("max");
      expect(levels).not.toContain("ultracode");
    }
  });
});
