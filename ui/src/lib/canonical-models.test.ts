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

const CLAUDE_FULL_EFFORT = ["low", "medium", "high", "xhigh", "max", "ultracode"];

const CLAUDE_LOCAL_MODEL_CASES = [
  ["claude-opus-5", "claude-opus-5"],
  ["claude-opus-5[1m]", "claude-opus-5-1m"],
  ["claude-fable-5", "claude-fable-5"],
  ["claude-sonnet-5", "claude-sonnet-5"],
  ["claude-haiku-4-5", "claude-haiku-4.5"],
] as const;

describe("Claude Local model catalogue", () => {
  it("uses the provider-current curated model choices", () => {
    expect(claudeLocalModels.map((model) => model.id)).toEqual(
      CLAUDE_LOCAL_MODEL_CASES.map(([modelId]) => modelId),
    );
  });

  it.each(CLAUDE_LOCAL_MODEL_CASES)(
    "round-trips %s through canonical model %s",
    (modelId, canonicalId) => {
      expect(CANONICAL_MODELS[canonicalId]).toBeDefined();
      expect(resolveCanonicalModel("claude_local", modelId)).toBe(canonicalId);
      expect(translateModel(canonicalId, "claude_local")).toBe(modelId);
    },
  );

  it("offers the full effort surface for every current model except Haiku", () => {
    for (const [, canonicalId] of CLAUDE_LOCAL_MODEL_CASES.slice(0, -1)) {
      expect(getAllowedEffortLevels("claude_local", canonicalId)).toEqual(
        CLAUDE_FULL_EFFORT,
      );
    }
    expect(getAllowedEffortLevels("claude_local", "claude-haiku-4.5")).toEqual([]);
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
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-sol");
    expect(codexLocalModels.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
  });

  it("keeps legacy Codex values readable without making them curated choices", () => {
    expect(resolveCanonicalModel("codex_local", "gpt-5")).toBe("gpt-5");
    expect(resolveCanonicalEffort("codex_local", "minimal")).toBe("minimal");
    expect(codexLocalModels.map((model) => model.id)).not.toContain("gpt-5");
    expect(getAllowedEffortLevels("codex_local", "gpt-5.5")).not.toContain("minimal");
    expect(getAllowedEffortLevels("codex_local", "gpt-5.5")).not.toContain("none");
  });

  it("models Codex effort support per verified model", () => {
    expect(getAllowedEffortLevels("codex_local", "gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getAllowedEffortLevels("codex_local", "gpt-5.6-terra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getAllowedEffortLevels("codex_local", "gpt-5.6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getAllowedEffortLevels("codex_local", "gpt-5.5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    for (const model of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]) {
      expect(getAllowedEffortLevels("codex_local", model)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
    }
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
    expect(resolveCanonicalEffort("codex_local", "max")).toBe("max");
    expect(translateEffort("max", "codex_local")).toEqual({
      field: "effort",
      value: "max",
    });
    expect(resolveCanonicalEffort("codex_local", "ultra")).toBe("ultra");
    expect(translateEffort("ultra", "codex_local")).toEqual({
      field: "effort",
      value: "ultra",
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

  it("does not introduce retired Codex choices when switching from Copilot", () => {
    expect(
      scopedRemap({
        fromAdapter: "copilot_cli",
        toAdapter: "codex_local",
        model: "gpt-5.3-codex",
        effort: "high",
      }),
    ).toEqual({
      model: targetDefaultModel.codex_local,
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
        model: "gpt-5.6-sol",
        effort: "ultra",
      }),
    ).toEqual({ model: targetDefaultModel.copilot_cli });
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
        model: "claude-opus-5",
        effort: "ultracode",
      }),
    ).toEqual({ model: targetDefaultModel.codex_local });
  });

  it("preserves max only when the target model supports it", () => {
    expect(
      scopedRemap({
        fromAdapter: "codex_local",
        toAdapter: "claude_local",
        model: "gpt-5.6-luna",
        effort: "max",
      }),
    ).toEqual({
      model: targetDefaultModel.claude_local,
      effort: { field: "effort", value: "max" },
    });
    expect(
      scopedRemap({
        fromAdapter: "claude_local",
        toAdapter: "codex_local",
        model: "claude-opus-5",
        effort: "max",
      }),
    ).toEqual({
      model: targetDefaultModel.codex_local,
      effort: { field: "effort", value: "max" },
    });
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
        model: "claude-opus-5",
        effort: "high",
      }),
    ).toBeUndefined();
  });
});
