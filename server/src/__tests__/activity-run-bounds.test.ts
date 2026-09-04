import { heartbeatRuns } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { activityService } from "../services/activity.js";

describe("issue run activity bounds", () => {
  it("applies default and maximum bounds to issue activity history", async () => {
    const query: Record<string, any> = {};
    query.from = vi.fn(() => query);
    query.where = vi.fn(() => query);
    query.orderBy = vi.fn(() => query);
    query.limit = vi.fn(async () => []);
    const service = activityService({ select: vi.fn(() => query) } as any);

    await service.forIssue("issue-1");
    await service.forIssue("issue-1", 50_000);

    expect(query.limit).toHaveBeenNthCalledWith(1, 200);
    expect(query.limit).toHaveBeenNthCalledWith(2, 500);
  });

  it("projects only bounded result fields and caps issue run history", async () => {
    const rows = [{
      runId: "run-1",
      resultJson: {
        summary: "x".repeat(512),
        result: "bounded",
      },
    }];
    const query: Record<string, any> = {};
    query.from = vi.fn(() => query);
    query.where = vi.fn(() => query);
    query.orderBy = vi.fn(() => query);
    query.limit = vi.fn(async () => rows);
    const select = vi.fn(() => query);

    const result = await activityService({ select } as any).runsForIssue(
      "company-1",
      "issue-1",
    );

    const selection = select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(selection.resultJson).not.toBe(heartbeatRuns.resultJson);
    expect(query.limit).toHaveBeenCalledWith(200);
    expect(result[0]?.resultJson).toEqual({
      summary: "x".repeat(500),
      result: "bounded",
    });
  });
});
