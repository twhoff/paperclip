/**
 * Canonical model/effort mapping shared across all adapters.
 *
 * Maps canonical model IDs to adapter-specific model IDs (aliases), and maps
 * canonical effort levels to the adapter-specific (field, value) they require.
 *
 * Used to intelligently translate model + effort when switching adapter types
 * so settings are preserved rather than reset to defaults.
 */

export type AdapterType =
  | "claude_local"
  | "codex_local"
  | "copilot_cli"
  | "cursor"
  | "gemini_local"
  | "opencode_local"
  | "oz_local"
  | "pi_local"
  | "openclaw_gateway";

export interface CanonicalModel {
  label: string;
  /** Per-adapter model ID. First element of an array is the preferred alias. */
  adapters: Partial<Record<AdapterType, string | string[]>>;
}

export interface CanonicalEffortLevel {
  label: string;
  /** Per-adapter effort configuration. Adapters absent don't support this level. */
  adapters: Partial<Record<AdapterType, { field: string; value: string }>>;
}

/**
 * Canonical model catalogue. Key = canonical model ID.
 * Ordered roughly from most capable to least within each family.
 *
 * Note: cursor's thinking models (e.g. "opus-4.6-thinking") encode effort in
 * the model ID — they are handled separately via CURSOR_THINKING_MODELS.
 */
export const CANONICAL_MODELS: Record<string, CanonicalModel> = {
  // ── Claude ──────────────────────────────────────────────────────────────
  "claude-opus-5": {
    label: "Claude Opus 5",
    adapters: {
      claude_local: "claude-opus-5",
    },
  },
  "claude-opus-5-1m": {
    label: "Claude Opus 5 (1M)",
    adapters: {
      claude_local: "claude-opus-5[1m]",
    },
  },
  "claude-fable-5": {
    label: "Claude Fable 5",
    adapters: {
      claude_local: "claude-fable-5",
    },
  },
  "claude-sonnet-5": {
    label: "Claude Sonnet 5",
    adapters: {
      claude_local: "claude-sonnet-5",
    },
  },
  "claude-opus-4.8": {
    label: "Claude Opus 4.8",
    adapters: {
      copilot_cli: "claude-opus-4.8",
    },
  },
  "claude-opus-4.8-1m": {
    label: "Claude Opus 4.8 (1M)",
    adapters: {
      copilot_cli: "claude-opus-4.8-1m",
    },
  },
  "claude-opus-4.7": {
    label: "Claude Opus 4.7",
    adapters: {
      copilot_cli: "claude-opus-4.7",
    },
  },
  "claude-opus-4.7-1m": {
    label: "Claude Opus 4.7 (1M)",
    adapters: {
      copilot_cli: "claude-opus-4.7-1m",
    },
  },
  "claude-sonnet-4.6": {
    label: "Claude Sonnet 4.6",
    adapters: {
      copilot_cli: "claude-sonnet-4.6",
      cursor: "sonnet-4.6",
    },
  },
  "claude-sonnet-4.6-1m": {
    label: "Claude Sonnet 4.6 (1M)",
    adapters: {
      copilot_cli: "claude-sonnet-4.6-1m",
    },
  },
  "claude-opus-4.5": {
    label: "Claude Opus 4.5",
    adapters: {
      copilot_cli: "claude-opus-4.5",
      cursor: "opus-4.5",
    },
  },
  "claude-sonnet-4.5": {
    label: "Claude Sonnet 4.5",
    adapters: {
      copilot_cli: "claude-sonnet-4.5",
      cursor: "sonnet-4.5",
      oz_local: "claude-4-5-sonnet",
    },
  },
  "claude-haiku-4.5": {
    label: "Claude Haiku 4.5",
    adapters: {
      claude_local: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
      copilot_cli: "claude-haiku-4.5",
      oz_local: "claude-4-5-haiku",
    },
  },
  "claude-sonnet-4": {
    label: "Claude Sonnet 4",
    adapters: {
      copilot_cli: "claude-sonnet-4",
    },
  },

  // ── GPT ─────────────────────────────────────────────────────────────────
  "gpt-5.6-sol": {
    label: "GPT-5.6 Sol",
    adapters: {
      codex_local: "gpt-5.6-sol",
    },
  },
  "gpt-5.6-terra": {
    label: "GPT-5.6 Terra",
    adapters: {
      codex_local: "gpt-5.6-terra",
    },
  },
  "gpt-5.6-luna": {
    label: "GPT-5.6 Luna",
    adapters: {
      codex_local: "gpt-5.6-luna",
    },
  },
  "gpt-5.5": {
    label: "GPT-5.5",
    adapters: {
      codex_local: "gpt-5.5",
      copilot_cli: "gpt-5.5",
    },
  },
  "gpt-5.4": {
    label: "GPT-5.4",
    adapters: {
      codex_local: "gpt-5.4",
      copilot_cli: "gpt-5.4",
    },
  },
  "gpt-5.3-codex": {
    label: "GPT-5.3 Codex",
    adapters: {
      copilot_cli: "gpt-5.3-codex",
      cursor: "gpt-5.3-codex",
    },
  },
  "gpt-5.3-codex-spark": {
    label: "GPT-5.3 Codex Spark",
    adapters: {
      codex_local: "gpt-5.3-codex-spark",
    },
  },
  "gpt-5.2-codex": {
    label: "GPT-5.2 Codex",
    adapters: {
      copilot_cli: "gpt-5.2-codex",
      cursor: "gpt-5.2-codex",
    },
  },
  "gpt-5.1-codex-max": {
    label: "GPT-5.1 Codex Max",
    adapters: {
      cursor: "gpt-5.1-codex-max",
    },
  },
  "gpt-5.1-codex-mini": {
    label: "GPT-5.1 Codex Mini",
    adapters: {
      cursor: "gpt-5.1-codex-mini",
    },
  },
  "gpt-5.4-mini": {
    label: "GPT-5.4 Mini",
    adapters: {
      codex_local: "gpt-5.4-mini",
      copilot_cli: "gpt-5.4-mini",
    },
  },
  "gpt-5-mini": {
    label: "GPT-5 Mini",
    adapters: {
      copilot_cli: "gpt-5-mini",
    },
  },
  "gpt-5.2": {
    label: "GPT-5.2",
    adapters: {
      copilot_cli: "gpt-5.2",
      cursor: "gpt-5.2",
    },
  },
  "gpt-4.1": {
    label: "GPT-4.1",
    adapters: {
      copilot_cli: "gpt-4.1",
    },
  },
  "gpt-5": {
    label: "GPT-5",
    adapters: {
      codex_local: "gpt-5",
      oz_local: "gpt-5",
    },
  },

  // ── Gemini ───────────────────────────────────────────────────────────────
  "gemini-3-pro": {
    label: "Gemini 3 Pro",
    adapters: {
      copilot_cli: "gemini-3-pro-preview",
      cursor: "gemini-3-pro",
      oz_local: "gemini-3-pro",
    },
  },
  "gemini-2.5-pro": {
    label: "Gemini 2.5 Pro",
    adapters: {
      gemini_local: "gemini-2.5-pro",
      oz_local: "gemini-2.5-pro",
    },
  },
  "gemini-2.5-flash": {
    label: "Gemini 2.5 Flash",
    adapters: {
      gemini_local: "gemini-2.5-flash",
    },
  },
  "gemini-2.5-flash-lite": {
    label: "Gemini 2.5 Flash Lite",
    adapters: {
      gemini_local: "gemini-2.5-flash-lite",
    },
  },
  "gemini-2.0-flash": {
    label: "Gemini 2.0 Flash",
    adapters: {
      gemini_local: "gemini-2.0-flash",
    },
  },
};

/**
 * Cursor model IDs that encode a "high/thinking" effort level in the model name.
 * Key = cursor model ID, value = canonical effort level.
 */
export const CURSOR_THINKING_MODELS: Record<string, string> = {
  "opus-4.5-thinking": "high",
  "sonnet-4.6-thinking": "high",
  "sonnet-4.5-thinking": "high",
};

/**
 * Canonical effort levels. Key = canonical effort level ID.
 *
 * Note: cursor's `mode` (plan/ask) is an execution mode — NOT a reasoning effort
 * level — so it is intentionally absent from this map.
 */
export const CANONICAL_EFFORT_LEVELS: Record<string, CanonicalEffortLevel> = {
  none: {
    label: "None",
    adapters: {
      codex_local: { field: "effort", value: "none" },
    },
  },
  low: {
    label: "Low",
    adapters: {
      claude_local: { field: "effort", value: "low" },
      codex_local: { field: "effort", value: "low" },
      copilot_cli: { field: "effort", value: "low" },
      opencode_local: { field: "variant", value: "low" },
      pi_local: { field: "thinking", value: "low" },
    },
  },
  medium: {
    label: "Medium",
    adapters: {
      claude_local: { field: "effort", value: "medium" },
      codex_local: { field: "effort", value: "medium" },
      copilot_cli: { field: "effort", value: "medium" },
      opencode_local: { field: "variant", value: "medium" },
      pi_local: { field: "thinking", value: "medium" },
    },
  },
  high: {
    label: "High",
    adapters: {
      claude_local: { field: "effort", value: "high" },
      codex_local: { field: "effort", value: "high" },
      copilot_cli: { field: "effort", value: "high" },
      opencode_local: { field: "variant", value: "high" },
      pi_local: { field: "thinking", value: "high" },
    },
  },
  xhigh: {
    label: "Extra High",
    adapters: {
      claude_local: { field: "effort", value: "xhigh" },
      codex_local: { field: "effort", value: "xhigh" },
      copilot_cli: { field: "effort", value: "xhigh" },
      pi_local: { field: "thinking", value: "xhigh" },
    },
  },
  minimal: {
    label: "Minimal",
    adapters: {
      codex_local: { field: "effort", value: "minimal" },
      opencode_local: { field: "variant", value: "minimal" },
      pi_local: { field: "thinking", value: "minimal" },
    },
  },
  max: {
    label: "Max",
    adapters: {
      claude_local: { field: "effort", value: "max" },
      codex_local: { field: "effort", value: "max" },
      opencode_local: { field: "variant", value: "max" },
    },
  },
  ultra: {
    label: "Ultra",
    adapters: {
      codex_local: { field: "effort", value: "ultra" },
    },
  },
  ultracode: {
    label: "Ultracode",
    adapters: {
      // claude_local only — for dynamic workflow generation and long, complex,
      // multi-file coding tasks. Copilot/codex/etc. have no ultracode level.
      claude_local: { field: "effort", value: "ultracode" },
    },
  },
  off: {
    label: "Off",
    adapters: {
      pi_local: { field: "thinking", value: "off" },
    },
  },
};

/**
 * Allowed effort levels per (adapter, canonical model). pcli-b9o.
 *
 * Used by the AgentConfigForm to populate the effort dropdown for the
 * currently-selected (adapter, model) tuple. If a model isn't listed for an
 * adapter, the adapter's `DEFAULT_ALLOWED_EFFORT_LEVELS[adapter]` is the
 * fallback (the union of all levels the adapter supports across its models).
 *
 * The same model can expose different effort levels via different platforms
 * (e.g. Copilot's gpt-5.2 does not support `xhigh`, while Codex's does). When
 * the user switches adapter or model, AgentConfigForm should reset the
 * `effort` field if its current value is no longer in the allowed set for
 * the new tuple.
 *
 * Keys are canonical model IDs from CANONICAL_MODELS. Map values are the
 * canonical effort level IDs (keys of CANONICAL_EFFORT_LEVELS) the
 * adapter+model combination accepts.
 */
export const ALLOWED_EFFORT_LEVELS: Partial<
  Record<AdapterType, Record<string, readonly string[]>>
> = {
  claude_local: {
    "claude-opus-5": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "claude-opus-5-1m": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "claude-fable-5": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "claude-haiku-4.5": [],
  },
  codex_local: {
    "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
    "gpt-5.5": ["low", "medium", "high", "xhigh"],
    "gpt-5.4": ["low", "medium", "high", "xhigh"],
    "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
    "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
  },
  copilot_cli: {
    // GPT-5.x models on Copilot CLI accept up to xhigh.
    "gpt-5.5": ["low", "medium", "high", "xhigh"],
    "gpt-5.4": ["low", "medium", "high", "xhigh"],
    "gpt-5.4-codex": ["low", "medium", "high", "xhigh"],
    "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
    "gpt-5.2-codex": ["low", "medium", "high", "xhigh"],
    "gpt-5.2": ["low", "medium", "high"],
    "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
    "gpt-5.1-codex-max": ["low", "medium", "high", "xhigh"],
    // Claude models proxied via Copilot stay on the Claude effort surface.
    // Note: max/ultracode are claude_local only — never exposed on copilot_cli.
    "claude-opus-4.8": ["low", "medium", "high", "xhigh"],
    "claude-opus-4.8-1m": ["low", "medium", "high", "xhigh"],
    "claude-opus-4.7": ["low", "medium", "high", "xhigh"],
    "claude-opus-4.7-1m": ["low", "medium", "high", "xhigh"],
    "claude-sonnet-4.6": ["low", "medium", "high", "xhigh"],
    "claude-sonnet-4.6-1m": ["low", "medium", "high", "xhigh"],
    "claude-opus-4.5": ["low", "medium", "high", "xhigh"],
    "claude-sonnet-4.5": ["low", "medium", "high", "xhigh"],
    "claude-haiku-4.5": ["low", "medium", "high", "xhigh"],
    // gpt-4.1 and older Claude/Gemini have no effort control.
    "gpt-4.1": [],
  },
};

/**
 * Per-adapter default effort levels (used as the fallback when a canonical
 * model has no explicit entry in ALLOWED_EFFORT_LEVELS, e.g. for adapters
 * that take the same effort surface regardless of model).
 */
export const DEFAULT_ALLOWED_EFFORT_LEVELS: Partial<Record<AdapterType, readonly string[]>> = {
  // claude_local: fallback for legacy saved models; current Haiku is overridden above.
  claude_local: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  // codex_local: fallback for legacy saved models that remain readable.
  codex_local: ["low", "medium", "high", "xhigh"],
  // copilot_cli: see per-model entries above; the default is the GPT-5.x surface
  // for any model that ALLOWED_EFFORT_LEVELS doesn't enumerate.
  copilot_cli: ["low", "medium", "high", "xhigh"],
  opencode_local: ["minimal", "low", "medium", "high", "max"],
  pi_local: ["off", "minimal", "low", "medium", "high", "xhigh"],
};

/**
 * Resolve the allowed canonical effort levels for the given (adapter, model)
 * tuple. Returns an empty array when the adapter doesn't support effort
 * configuration at all (e.g. gemini_local, oz_local, openclaw_gateway).
 *
 * @param adapterType  The adapter type currently configured.
 * @param canonicalModelId Canonical model ID (key of CANONICAL_MODELS), or
 *   the adapter-specific model ID (in which case the reverse map is used).
 */
export function getAllowedEffortLevels(
  adapterType: AdapterType | string,
  canonicalModelId: string | null | undefined,
): readonly string[] {
  const adapter = adapterType as AdapterType;
  const perModel = ALLOWED_EFFORT_LEVELS[adapter];
  if (canonicalModelId && perModel && canonicalModelId in perModel) {
    return perModel[canonicalModelId];
  }
  return DEFAULT_ALLOWED_EFFORT_LEVELS[adapter] ?? [];
}

/**
 * Fields that are semantically shared across most local adapters and should be
 * preserved verbatim when switching adapter types (unless already overridden in
 * the overlay by the user).
 */
export const SHARED_ADAPTER_FIELDS = [
  "instructionsFilePath",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "cwd",
  "env",
  "command",
  "extraArgs",
  "timeoutSec",
  "graceSec",
  "workspaceStrategy",
  "workspaceRuntime",
  "paperclipSkillSync",
] as const;

// ── Built-in reverse lookup maps ────────────────────────────────────────────

/** (adapterType + ":" + adapterModelId) → canonicalModelId */
const MODEL_REVERSE = new Map<string, string>();
for (const [canonicalId, cm] of Object.entries(CANONICAL_MODELS)) {
  for (const [adapterType, adapterModel] of Object.entries(cm.adapters)) {
    const ids = Array.isArray(adapterModel) ? adapterModel : [adapterModel];
    for (const id of ids) {
      MODEL_REVERSE.set(`${adapterType}:${id}`, canonicalId);
    }
  }
}

/** (adapterType + ":" + effortValue) → canonicalEffortLevel */
const EFFORT_REVERSE = new Map<string, string>();
for (const [canonicalLevel, ce] of Object.entries(CANONICAL_EFFORT_LEVELS)) {
  for (const [adapterType, effortCfg] of Object.entries(ce.adapters)) {
    EFFORT_REVERSE.set(`${adapterType}:${effortCfg.value}`, canonicalLevel);
  }
}

// ── Public helpers ───────────────────────────────────────────────────────────

/**
 * Given a model ID used in a specific adapter, return the canonical model ID.
 * Handles cursor's thinking-suffix models (e.g. "opus-4.6-thinking" → "claude-opus-4.6").
 */
export function resolveCanonicalModel(adapterType: string, modelId: string): string | undefined {
  if (adapterType === "cursor" && CURSOR_THINKING_MODELS[modelId]) {
    // Strip thinking suffix to find the base model canonical ID
    const base = modelId.replace(/-thinking$/, "");
    return MODEL_REVERSE.get(`cursor:${base}`);
  }
  return MODEL_REVERSE.get(`${adapterType}:${modelId}`);
}

/**
 * Given a canonical model ID and target adapter, return the best adapter-specific
 * model ID. When switching TO cursor with a high canonical effort, prefers the
 * `-thinking` variant.
 */
export function translateModel(
  canonicalId: string,
  toAdapter: string,
  canonicalEffort?: string,
): string | undefined {
  const cm = CANONICAL_MODELS[canonicalId];
  if (!cm) return undefined;
  const adapterModel = cm.adapters[toAdapter as AdapterType];
  if (!adapterModel) return undefined;
  const base = Array.isArray(adapterModel) ? adapterModel[0] : adapterModel;

  if (toAdapter === "cursor" && canonicalEffort === "high") {
    const thinkingVariant = `${base}-thinking`;
    if (thinkingVariant in CURSOR_THINKING_MODELS) return thinkingVariant;
  }
  return base;
}

/**
 * Extract the raw effort value from an adapterConfig object, using the correct
 * field name for the given adapter type.
 *
 * As of pcli-b9o (2026-05-17) all stdio adapters (claude_local, codex_local,
 * copilot_cli) share a single `effort` field. The legacy `modelReasoningEffort`
 * (codex_local) and `reasoningEffort` (copilot_cli) names are still read as
 * fallbacks so already-persisted configs continue to work until the one-shot
 * migration has run; once the migration runs the fallbacks become dead paths
 * that can be removed in a follow-up.
 */
export function getAdapterEffortValue(
  adapterType: string,
  config: Record<string, unknown>,
): string {
  switch (adapterType) {
    case "codex_local":
      return String(
        config.effort ?? config.modelReasoningEffort ?? "",
      );
    case "copilot_cli":
      return String(config.effort ?? config.reasoningEffort ?? "");
    case "opencode_local":
      return String(config.variant ?? "");
    case "pi_local":
      return String(config.thinking ?? "");
    // cursor's `mode` (plan/ask) is an execution mode — not a canonical effort level
    default:
      return String(config.effort ?? "");
  }
}

/**
 * Given an adapter type and the raw effort value from its config, return the
 * canonical effort level. Returns undefined for cursor (mode ≠ reasoning effort)
 * or when the value is empty / unrecognised.
 */
export function resolveCanonicalEffort(adapterType: string, effortValue: string): string | undefined {
  // cursor's mode (plan/ask) is NOT a reasoning effort level
  if (adapterType === "cursor" || !effortValue) return undefined;
  return EFFORT_REVERSE.get(`${adapterType}:${effortValue}`);
}

/**
 * Given a canonical effort level and a target adapter, return the adapter-specific
 * { field, value } pair. Falls back to "high" when the exact level isn't supported
 * (e.g. xhigh → high for claude_local, max → high for copilot_cli).
 */
export function translateEffort(
  canonicalLevel: string,
  toAdapter: string,
): { field: string; value: string } | undefined {
  if (!canonicalLevel) return undefined;

  const ce = CANONICAL_EFFORT_LEVELS[canonicalLevel];
  const direct = ce?.adapters[toAdapter as AdapterType];
  if (direct) return direct;

  // Graceful fallback: unsupported extreme levels → high
  if (
    canonicalLevel === "xhigh" ||
    canonicalLevel === "max" ||
    canonicalLevel === "ultra" ||
    canonicalLevel === "ultracode"
  ) {
    return CANONICAL_EFFORT_LEVELS["high"]?.adapters[toAdapter as AdapterType];
  }

  return undefined;
}

type ScopedCodexAdapter = "codex_local" | "copilot_cli" | "claude_local" | "oz_local";

const CODEX_SCOPED_TARGETS = new Set<ScopedCodexAdapter>([
  "copilot_cli",
  "claude_local",
  "oz_local",
]);

function isScopedCodexPair(fromAdapter: string, toAdapter: string): boolean {
  if (fromAdapter === toAdapter) return false;
  if (fromAdapter === "codex_local") {
    return CODEX_SCOPED_TARGETS.has(toAdapter as ScopedCodexAdapter);
  }
  if (toAdapter === "codex_local") {
    return CODEX_SCOPED_TARGETS.has(fromAdapter as ScopedCodexAdapter);
  }
  return false;
}

function resolveScopedCanonicalModel(adapterType: string, modelId: string): string | undefined {
  const resolved = resolveCanonicalModel(adapterType, modelId);
  if (resolved) return resolved;
  if (adapterType === "oz_local" && modelId === "gpt-5-4-high") return "gpt-5.4";
  return undefined;
}

function resolveScopedCanonicalEffort(
  adapterType: string,
  modelId: string,
  effortValue: string,
): string | undefined {
  const resolved = resolveCanonicalEffort(adapterType, effortValue);
  if (resolved) return resolved;
  if (adapterType === "oz_local" && modelId === "gpt-5-4-high") return "high";
  return undefined;
}

function translateScopedModel(
  canonicalModel: string | undefined,
  canonicalEffort: string | undefined,
  fromAdapter: string,
  toAdapter: string,
  sourceModel: string,
): string | undefined {
  if (!canonicalModel) return undefined;

  if (fromAdapter === "oz_local" && toAdapter === "codex_local" && sourceModel === "gpt-5") {
    return undefined;
  }

  if (fromAdapter === "codex_local" && toAdapter === "oz_local") {
    if (canonicalModel === "gpt-5.4" && canonicalEffort === "high") return "gpt-5-4-high";
    if (canonicalModel === "gpt-5") return "gpt-5";
    return undefined;
  }

  if (fromAdapter === "oz_local" && toAdapter === "codex_local" && sourceModel === "gpt-5-4-high") {
    return "gpt-5.4";
  }

  return translateModel(canonicalModel, toAdapter, canonicalEffort);
}

function getAllowedEffortLevelsForResolvedTarget(
  adapterType: string,
  canonicalModelId: string | undefined,
): readonly string[] {
  const adapter = adapterType as AdapterType;
  const perModel = ALLOWED_EFFORT_LEVELS[adapter];
  if (perModel) {
    if (!canonicalModelId) return [];
    if (canonicalModelId in perModel) return perModel[canonicalModelId];
  }
  return DEFAULT_ALLOWED_EFFORT_LEVELS[adapter] ?? [];
}

function translateScopedEffort(
  canonicalEffort: string | undefined,
  toAdapter: string,
  targetCanonicalModel: string | undefined,
): { field: string; value: string } | undefined {
  if (!canonicalEffort) return undefined;
  const direct = CANONICAL_EFFORT_LEVELS[canonicalEffort]?.adapters[toAdapter as AdapterType];
  if (!direct) return undefined;
  const allowed = getAllowedEffortLevelsForResolvedTarget(toAdapter, targetCanonicalModel);
  if (!allowed.includes(canonicalEffort)) return undefined;
  return direct;
}

export function remapScopedCodexAdapterSwitch(input: {
  fromAdapter: string;
  toAdapter: string;
  sourceModel?: string;
  sourceEffort?: string;
  targetDefaultModel: string;
}): { model: string; effort?: { field: string; value: string } } | undefined {
  const sourceModel = input.sourceModel ?? "";
  if (!isScopedCodexPair(input.fromAdapter, input.toAdapter)) return undefined;

  const canonicalModel = sourceModel
    ? resolveScopedCanonicalModel(input.fromAdapter, sourceModel)
    : undefined;
  const canonicalEffort = resolveScopedCanonicalEffort(
    input.fromAdapter,
    sourceModel,
    input.sourceEffort ?? "",
  );
  const translatedModel = translateScopedModel(
    canonicalModel,
    canonicalEffort,
    input.fromAdapter,
    input.toAdapter,
    sourceModel,
  );
  const model = translatedModel ?? input.targetDefaultModel;
  const targetCanonicalModel = model
    ? resolveScopedCanonicalModel(input.toAdapter, model)
    : undefined;
  const effort = translateScopedEffort(canonicalEffort, input.toAdapter, targetCanonicalModel);

  return effort ? { model, effort } : { model };
}
