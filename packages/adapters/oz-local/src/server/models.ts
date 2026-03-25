import type { AdapterModel } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { models as staticModels } from "../index.js";

function parseOzModelList(stdout: string): AdapterModel[] {
  try {
    const parsed = JSON.parse(stdout.trim());
    if (!Array.isArray(parsed)) return [];
    const result: AdapterModel[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id) continue;
      result.push({ id, label: id });
    }
    return result;
  } catch {
    return [];
  }
}

export async function listOzModels(command = "oz"): Promise<AdapterModel[]> {
  try {
    const probe = await runChildProcess(
      `oz-model-list-${Date.now()}`,
      command,
      ["model", "list", "--output-format", "json"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 15,
        graceSec: 5,
        onLog: async () => {},
      },
    );
    if ((probe.exitCode ?? 1) !== 0) return staticModels;
    const discovered = parseOzModelList(probe.stdout);
    if (discovered.length === 0) return staticModels;
    return discovered;
  } catch {
    return staticModels;
  }
}
