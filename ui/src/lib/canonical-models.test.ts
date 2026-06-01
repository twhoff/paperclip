import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  models as codexLocalModels,
} from "@paperclipai/adapter-codex-local";
import { models as claudeLocalModels } from "@paperclipai/adapter-claude-local";
import { models as copilotCliModels } from "@paperclipai/adapter-copilot-cli";
import { DEFAULT_OZ_MODEL } from "@paperclipai/adapter-oz-local";
import {
  CANONICAL_MODELS,
  CANONICAL_EFFORT_LEVELS,
  getAllowedEffortLevels,
  remapScopedCodexAdapterSwitch,
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

const targetDefaultModel = {
  codex_local: DEFAULT_CODEX_LOCAL_MODEL,
  copilot_cli: copilotCliModels[0]?.id ?? "",
  claude_local: claudeLocalModels[0]?.id ?? "",
  oz_local: DEFAULT_OZ_MODEL,
};

function scopedRemap(input: {
  fromAdapter: string;
  toAdapter: string;
  model?: string;
  effort?: string;
}) {
  return remapScopedCodexAdapterSwitch({
    fromAdapter: input.fromAdapter,
    toAdapter: input.toAdapter,
    sourceModel: input.model,
    sourceEffort: input.effort,
    targetDefaultModel:
      targetDefaultModel[input.toAdapter as keyof typeof targetDefaultModel] ?? "",
  });
}

describe("Codex Local model catalogue", () => {
  it("uses the verified Codex default and curated model choices", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.5");
    expect(codexLocalModels.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
    ]);
  });

  it("keeps legacy Codex values readable without making them curated choices", () => {
    expect(resolveCanonicalModel("codex_local", "gpt-5")).toBe("gpt-5");
    expect(resolveCanonicalEffort("codex_local", "minimal")).toBe("minimal");
    expect(codexLocalModels.map((model) => model.id)).not.toContain("gpt-5");
    expect(getAllowedEffortLevels("codex_local", "gpt-5.5")).not.toContain("minimal");
  });

  it("models Codex effort support per verified model", () => {
    expect(getAllowedEffortLevels("codex_local", "gpt-5.5")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getAllowedEffortLevels("codex_local", "gpt-5.3-codex")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getAllowedEffortLevels("codex_local", "gpt-5.3-codex-spark")).toEqual([]);
  });

  it("translates Codex-only effort levels through canonical helpers", () => {
    expect(resolveCanonicalEffort("codex_local", "none")).toBe("none");
    expect(translateEffort("none", "codex_local")).toEqual({
      field: "effort",
      value: "none",
    });
    expect(translateEffort("xhigh", "codex_local")).toEqual({
      field: "effort",
      value: "xhigh",
    });
  });
});

describe("scoped Codex Local adapter switching remapping", () => {
  it("preserves shared Codex to Copilot model and effort equivalents", () => {
    expect(
      scopedRemap({
        fromAdapter: "codex_local",
        toAdapter: "copilot_cli",
        model: "gpt-5.4-mini",
        effort: "xhigh",
      }),
    ).toEqual({
      model: "gpt-5.4-mini",
      effort: { field: "effort", value: "xhigh" },
    });
  });

  it("preserves shared Copilot to Codex model and effort equivalents", () => {
    expect(
      scopedRemap({
        fromAdapter: "copilot_cli",
        toAdapter: "codex_local",
        model: "gpt-5.3-codex",
        effort: "high",
      }),
    ).toEqual({
      model: "gpt-5.3-codex",
      effort: { field: "effort", value: "high" },
    });
  });

  it("falls back when a source model has no target equivalent", () => {
    expect(
      scopedRemap({
        fromAdapter: "codex_local",
        toAdapter: "copilot_cli",
        model: "gpt-5.3-codex-spark",
        effort: "high",
      }),
    ).toEqual({ model: targetDefaultModel.copilot_cli });
  });

  it("does not persist unsupported effort values or invalid model-effort combinations", () => {
    expect(
      scopedRemap({
        fromAdapter: "codex_local",
        toAdapter: "copilot_cli",
        model: "gpt-5.2",
        effort: "xhigh",
      }),
    ).toEqual({ model: "gpt-5.2" });
    expect(
      scopedRemap({
        fromAdapter: "codex_local",
        toAdapter: "copilot_cli",
        model: "gpt-5.4",
        effort: "none",
      }),
    ).toEqual({ model: "gpt-5.4" });
  });

  it("preserves effort, not model, between Codex and Claude where only effort is equivalent", () => {
    expect(
      scopedRemap({
        fromAdapter: "codex_local",
        toAdapter: "claude_local",
        model: "gpt-5.5",
        effort: "high",
      }),
    ).toEqual({
      model: targetDefaultModel.claude_local,
      effort: { field: "effort", value: "high" },
    });
    expect(
      scopedRemap({
        fromAdapter: "claude_local",
        toAdapter: "codex_local",
        model: "claude-opus-4-8",
        effort: "ultracode",
      }),
    ).toEqual({ model: targetDefaultModel.codex_local });
  });

  it("maps only real Codex and Oz semantic equivalents", () => {
    expect(
      scopedRemap({
        fromAdapter: "codex_local",
        toAdapter: "oz_local",
        model: "gpt-5.4",
        effort: "high",
      }),
    ).toEqual({ model: "gpt-5-4-high" });
    expect(
      scopedRemap({
        fromAdapter: "oz_local",
        toAdapter: "codex_local",
        model: "gpt-5-4-high",
      }),
    ).toEqual({
      model: "gpt-5.4",
      effort: { field: "effort", value: "high" },
    });
  });

  it("keeps legacy outbound Oz mapping readable without introducing deprecated inbound Codex choices", () => {
    expect(
      scopedRemap({
        fromAdapter: "codex_local",
        toAdapter: "oz_local",
        model: "gpt-5",
      }),
    ).toEqual({ model: "gpt-5" });
    expect(
      scopedRemap({
        fromAdapter: "oz_local",
        toAdapter: "codex_local",
        model: "gpt-5",
      }),
    ).toEqual({ model: targetDefaultModel.codex_local });
  });

  it("does not add behavior for adapter pairs outside the Codex scoped remapping", () => {
    expect(
      scopedRemap({
        fromAdapter: "claude_local",
        toAdapter: "copilot_cli",
        model: "claude-opus-4-8",
        effort: "high",
      }),
    ).toBeUndefined();
  });
});
