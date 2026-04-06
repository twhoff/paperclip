import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentService } from "../services/agents.ts";

const agentId = "agent-1";
const companyId = "company-1";
const pausedDate = new Date("2026-04-05T12:00:00.000Z");

function makePausedAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    name: "Stale Agent",
    role: "engineer",
    title: "Senior Engineer",
    icon: null,
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 5000,
    spentMonthlyCents: 0,
    metadata: null,
    permissions: null,
    status: "paused",
    pauseReason: "system",
    pausedAt: pausedDate,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-03-19T00:00:00.000Z"),
    updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Creates a mock DB that:
 * - select() returns the agent for getById, then empty for spend hydration
 * - update().set() captures the patch and returns the "updated" agent
 */
function createMockDb(agent: Record<string, unknown>) {
  let selectCallCount = 0;
  let capturedSetData: Record<string, unknown> | null = null;

  const updateReturningChain = {
    then: vi.fn((resolve: (rows: unknown[]) => unknown) => {
      const updated = { ...agent, ...capturedSetData };
      return Promise.resolve(resolve([updated]));
    }),
  };

  const updateWhereChain = {
    returning: vi.fn(() => updateReturningChain),
  };

  const updateSetChain = {
    where: vi.fn(() => updateWhereChain),
  };

  const updateChain = {
    set: vi.fn((data: Record<string, unknown>) => {
      capturedSetData = data;
      return updateSetChain;
    }),
  };

  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    groupBy: vi.fn(() => selectChain),
    then: vi.fn((resolve: (rows: unknown[]) => unknown) => {
      selectCallCount++;
      // First select: getById, second: spend hydration
      if (selectCallCount % 2 === 1) {
        return Promise.resolve(resolve([agent]));
      }
      return Promise.resolve(resolve([]));
    }),
  };

  return {
    db: {
      select: vi.fn(() => selectChain),
      update: vi.fn(() => updateChain),
      insert: vi.fn(() => ({ values: vi.fn() })),
    },
    getCapturedSetData: () => capturedSetData,
  };
}

describe("agent pause metadata cleanup on status change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears pauseReason and pausedAt when status changes from paused to idle", async () => {
    const agent = makePausedAgent();
    const mock = createMockDb(agent);
    const svc = agentService(mock.db as any);

    await svc.update(agent.id, { status: "idle" });

    const setData = mock.getCapturedSetData();
    expect(setData).toBeTruthy();
    expect(setData!.pauseReason).toBeNull();
    expect(setData!.pausedAt).toBeNull();
    expect(setData!.status).toBe("idle");
  });

  it("clears pauseReason and pausedAt when status changes from paused to running", async () => {
    const agent = makePausedAgent();
    const mock = createMockDb(agent);
    const svc = agentService(mock.db as any);

    await svc.update(agent.id, { status: "running" });

    const setData = mock.getCapturedSetData();
    expect(setData).toBeTruthy();
    expect(setData!.pauseReason).toBeNull();
    expect(setData!.pausedAt).toBeNull();
  });

  it("does NOT clear pause metadata when status remains paused", async () => {
    const agent = makePausedAgent();
    const mock = createMockDb(agent);
    const svc = agentService(mock.db as any);

    await svc.update(agent.id, { status: "paused" });

    const setData = mock.getCapturedSetData();
    expect(setData).toBeTruthy();
    // Should NOT have added null overrides
    expect(Object.prototype.hasOwnProperty.call(setData, "pauseReason")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(setData, "pausedAt")).toBe(false);
  });

  it("does NOT clear pause metadata when no status change is requested", async () => {
    const agent = makePausedAgent();
    const mock = createMockDb(agent);
    const svc = agentService(mock.db as any);

    await svc.update(agent.id, { title: "New Title" });

    const setData = mock.getCapturedSetData();
    expect(setData).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(setData, "pauseReason")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(setData, "pausedAt")).toBe(false);
  });

  it("respects explicit pauseReason in the patch data", async () => {
    const agent = makePausedAgent();
    const mock = createMockDb(agent);
    const svc = agentService(mock.db as any);

    await svc.update(agent.id, {
      status: "idle",
      pauseReason: "manual-override" as any,
    });

    const setData = mock.getCapturedSetData();
    expect(setData).toBeTruthy();
    // Should keep the explicitly provided value, not override to null
    expect(setData!.pauseReason).toBe("manual-override");
  });

  it("clears stale metadata even when agent is not in paused status but has stale fields", async () => {
    // Agent status is already "running" but still has stale pauseReason/pausedAt
    const agent = makePausedAgent({
      status: "running",
      pauseReason: "budget",
      pausedAt: pausedDate,
    });
    const mock = createMockDb(agent);
    const svc = agentService(mock.db as any);

    // Setting status to idle (different from current "running") should still clear
    await svc.update(agent.id, { status: "idle" });

    const setData = mock.getCapturedSetData();
    expect(setData).toBeTruthy();
    expect(setData!.pauseReason).toBeNull();
    expect(setData!.pausedAt).toBeNull();
  });
});
