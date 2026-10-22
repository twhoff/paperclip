import { describe, expect, it } from "vitest";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import { isAdapterTypeDisabled } from "./disabled";

describe("isAdapterTypeDisabled", () => {
  it("disables Copilot CLI", () => {
    expect(isAdapterTypeDisabled("copilot_cli")).toBe(true);
  });

  it("leaves every other adapter type enabled", () => {
    const others = AGENT_ADAPTER_TYPES.filter((type) => type !== "copilot_cli");
    expect(others.length).toBeGreaterThan(0);
    for (const type of others) {
      expect(isAdapterTypeDisabled(type)).toBe(false);
    }
  });
});
