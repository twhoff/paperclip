import { spawnSync } from "node:child_process";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as staticModels } from "../index.js";

const COPILOT_MODELS_TIMEOUT_MS = 45_000;
const COPILOT_MODELS_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 256 * 1024;

let cached: { command: string; expiresAt: number; models: AdapterModel[] } | null = null;

/**
 * Parse the model list from `copilot help config` output.
 *
 * The relevant section looks like:
 *   `model`: AI model to use...
 *     - "claude-sonnet-4.6"
 *     - "gpt-5.4"
 *     ...
 *   `mouse`: ...
 */
export function parseCopilotHelpConfigModels(output: string): AdapterModel[] {
  const lines = output.split(/\r?\n/);
  const discovered: AdapterModel[] = [];
  let inModelSection = false;

  for (const line of lines) {
    if (!inModelSection) {
      if (/^\s+`model`:/.test(line)) {
        inModelSection = true;
      }
      continue;
    }

    // Bullet point: four spaces + dash + quoted model id
    const match = line.match(/^\s+-\s+"([^"]+)"/);
    if (match) {
      const id = match[1].trim();
      if (id) discovered.push({ id, label: id });
      continue;
    }

    // A new config key or blank line terminates the section
    if (line.trim() === "" || /^\s+`[^`]+`:/.test(line)) break;
  }

  return discovered;
}

/**
 * Merge dynamically discovered models with the static fallback list.
 * - Dynamic models are authoritative (reflect what the installed CLI supports).
 * - Static labels replace raw IDs for any model present in both lists.
 * - "auto" (static-only) is prepended as it's always valid but not listed in help config.
 */
function mergeWithStatic(discovered: AdapterModel[]): AdapterModel[] {
  const staticById = new Map(staticModels.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const result: AdapterModel[] = [];

  // "auto" first — always valid, never appears in help config output
  const autoModel = staticById.get("auto");
  if (autoModel) {
    seen.add("auto");
    result.push(autoModel);
  }

  // Dynamic models with labels enriched from static where available
  for (const m of discovered) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const known = staticById.get(m.id);
    result.push({ id: m.id, label: known?.label ?? m.id });
  }

  // Static-only models appended at end (in case dynamic discovery missed any)
  for (const m of staticModels) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    result.push(m);
  }

  return result;
}

export async function listCopilotCliModels(command = "copilot"): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cached && cached.command === command && cached.expiresAt > now) {
    return cached.models;
  }

  try {
    const result = spawnSync(command, ["help", "config"], {
      encoding: "utf8",
      timeout: COPILOT_MODELS_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const hasError = Boolean(result.error) || result.status === null;

    if (hasError && stdout.trim().length === 0) {
      return mergeWithStatic([]);
    }

    const discovered = parseCopilotHelpConfigModels(stdout);
    if (discovered.length === 0) {
      return mergeWithStatic([]);
    }

    const merged = mergeWithStatic(discovered);
    cached = { command, expiresAt: now + COPILOT_MODELS_CACHE_TTL_MS, models: merged };
    return merged;
  } catch {
    return mergeWithStatic([]);
  }
}

export function resetCopilotModelsCacheForTests(): void {
  cached = null;
}
