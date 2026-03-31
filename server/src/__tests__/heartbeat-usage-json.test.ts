import { describe, expect, it } from "vitest";
import { buildHeartbeatUsageJson } from "../services/heartbeat.js";

describe("buildHeartbeatUsageJson", () => {
  it("persists premiumRequests from adapter results into usage_json", () => {
    const usageJson = buildHeartbeatUsageJson({
      normalizedUsage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 12,
      },
      rawUsage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 12,
      },
      derivedFromSessionTotals: false,
      persistedSessionId: "session-123",
      sessionReused: false,
      taskSessionReused: false,
      freshSession: true,
      sessionRotated: false,
      sessionRotationReason: null,
      adapterResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "github",
        biller: "github",
        model: "gpt-5.4",
        billingType: "subscription_included",
        premiumRequests: 2,
      },
      costUsdForUsage: null,
      resolvedCost: {
        rawUnits: null,
        rawUnitType: null,
      },
    });

    expect(usageJson).toMatchObject({
      outputTokens: 12,
      rawOutputTokens: 12,
      premiumRequests: 2,
      provider: "github",
      biller: "github",
      billingType: "subscription_included",
    });
  });
});