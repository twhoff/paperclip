import { describe, expect, it } from "vitest";
import { summarizeShutdownImpact } from "../lib/shutdown-impact";

const company = { id: "co-1", name: "Acme" };

describe("summarizeShutdownImpact", () => {
  it("counts affected, running, paused, terminated, loading, and error states", () => {
    const summary = summarizeShutdownImpact([
      {
        company,
        agents: [
          { status: "idle" },
          { status: "running" },
          { status: "error" },
          { status: "paused" },
          { status: "terminated" },
        ] as any,
      },
      {
        company: { id: "co-2", name: "Beta" },
        isLoading: true,
        isError: true,
      },
    ]);

    expect(summary).toEqual({
      companyCount: 2,
      affectedAgentCount: 3,
      runningAgentCount: 1,
      alreadyPausedCount: 1,
      terminatedCount: 1,
      loadingCompanyCount: 1,
      errorCompanyCount: 1,
    });
  });
});
