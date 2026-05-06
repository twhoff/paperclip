import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  resume: vi.fn(),
  pause: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { shutdownService } from "../services/shutdown.js";
import type { ShutdownTargets } from "../services/shutdown.js";

type ScenarioState = {
  pausedRows: { id: string; companyId: string }[];
  inFlightRows: { agentId: string }[];
  shutdownPausedRows: { id: string; companyId: string }[];
};

function makeDb(state: ScenarioState) {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => state.pausedRows),
        })),
      })),
    })),
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn((_table: unknown) => ({
        where: vi.fn(async () => {
          // Heuristic: if the selection asked for `agentId`, this is the
          // pollInFlight query; if it asked for `id` + `companyId`, this is
          // the listShutdownPausedAgents query.
          if (selection && "agentId" in selection) {
            return state.inFlightRows;
          }
          return state.shutdownPausedRows;
        }),
      })),
    })),
  };
}

function makeTargets(): ShutdownTargets & { exit: ReturnType<typeof vi.fn> } {
  return {
    httpServer: {
      close: (cb?: (err?: Error) => void) => {
        if (cb) cb();
      },
    } as unknown as ShutdownTargets["httpServer"],
    stopEmbeddedPostgres: vi.fn(async () => {}),
    exit: vi.fn(),
  };
}

describe("shutdownService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("starts in idle state", () => {
    const svc = shutdownService(makeDb({ pausedRows: [], inFlightRows: [], shutdownPausedRows: [] }) as never);
    const state = svc.getState();
    expect(state.phase).toBe("idle");
    expect(state.exitProcess).toBe(false);
    expect(state.inFlightAgentCount).toBe(0);
  });

  it("initiate transitions to draining and pauses agents", async () => {
    const state: ScenarioState = {
      pausedRows: [
        { id: "agent-1", companyId: "co-1" },
        { id: "agent-2", companyId: "co-1" },
      ],
      inFlightRows: [{ agentId: "agent-2" }],
      shutdownPausedRows: [],
    };
    const svc = shutdownService(makeDb(state) as never);
    svc.setTargets(makeTargets());

    const result = await svc.initiate({
      timeoutMs: 60_000,
      exitProcess: false,
      actorId: "user-1",
      actorType: "user",
    });

    expect(result.phase).toBe("draining");
    expect(result.exitProcess).toBe(false);
    expect(result.timeoutMs).toBe(60_000);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "system.shutdown.initiated",
        companyId: "co-1",
        details: expect.objectContaining({ exitProcess: false }),
      }),
    );
  });

  it("initiate returns 409-style conflict when already in progress", async () => {
    const state: ScenarioState = {
      pausedRows: [{ id: "agent-1", companyId: "co-1" }],
      inFlightRows: [{ agentId: "agent-1" }],
      shutdownPausedRows: [],
    };
    const svc = shutdownService(makeDb(state) as never);
    svc.setTargets(makeTargets());

    await svc.initiate({ actorId: "u", actorType: "user" });
    await expect(svc.initiate({ actorId: "u", actorType: "user" })).rejects.toThrow(
      /already in progress/i,
    );
  });

  it("transitions to drained when no in-flight runs and exitProcess=false", async () => {
    const state: ScenarioState = {
      pausedRows: [{ id: "agent-1", companyId: "co-1" }],
      inFlightRows: [],
      shutdownPausedRows: [],
    };
    const svc = shutdownService(makeDb(state) as never);
    svc.setTargets(makeTargets());

    await svc.initiate({ exitProcess: false, actorId: "u", actorType: "user" });
    // Allow the immediate first tick to resolve.
    await vi.runAllTimersAsync();

    expect(svc.getState().phase).toBe("drained");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "system.shutdown.drained" }),
    );
  });

  it("calls process.exit when exitProcess=true and drain completes", async () => {
    const state: ScenarioState = {
      pausedRows: [{ id: "agent-1", companyId: "co-1" }],
      inFlightRows: [],
      shutdownPausedRows: [],
    };
    const svc = shutdownService(makeDb(state) as never);
    const targets = makeTargets();
    svc.setTargets(targets);

    await svc.initiate({ exitProcess: true, actorId: "u", actorType: "user" });
    await vi.runAllTimersAsync();

    expect(targets.stopEmbeddedPostgres).toHaveBeenCalled();
    expect(targets.exit).toHaveBeenCalledWith(0);
    expect(svc.getState().phase).toBe("stopping");
  });

  it("force-cancels stragglers after timeout", async () => {
    const state: ScenarioState = {
      pausedRows: [{ id: "agent-1", companyId: "co-1" }],
      inFlightRows: [{ agentId: "agent-1" }],
      shutdownPausedRows: [],
    };
    const svc = shutdownService(makeDb(state) as never);
    svc.setTargets(makeTargets());

    await svc.initiate({
      timeoutMs: 10_000,
      exitProcess: false,
      actorId: "u",
      actorType: "user",
    });
    // Advance past the deadline so the next tick triggers force-cancel.
    await vi.advanceTimersByTimeAsync(11_000);

    expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith("agent-1");
    expect(svc.getState().phase).toBe("drained");
  });

  it("resume from draining returns to idle and resumes shutdown-paused agents", async () => {
    const state: ScenarioState = {
      pausedRows: [{ id: "agent-1", companyId: "co-1" }],
      inFlightRows: [{ agentId: "agent-1" }],
      shutdownPausedRows: [{ id: "agent-1", companyId: "co-1" }],
    };
    const svc = shutdownService(makeDb(state) as never);
    svc.setTargets(makeTargets());

    await svc.initiate({ actorId: "u", actorType: "user" });
    const result = await svc.resume({ actorId: "u2", actorType: "user" });

    expect(result.phase).toBe("idle");
    expect(mockAgentService.resume).toHaveBeenCalledWith("agent-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "system.shutdown.cancelled" }),
    );
  });

  it("resume from drained logs system.shutdown.resumed", async () => {
    const state: ScenarioState = {
      pausedRows: [{ id: "agent-1", companyId: "co-1" }],
      inFlightRows: [],
      shutdownPausedRows: [{ id: "agent-1", companyId: "co-1" }],
    };
    const svc = shutdownService(makeDb(state) as never);
    svc.setTargets(makeTargets());

    await svc.initiate({ exitProcess: false, actorId: "u", actorType: "user" });
    await vi.runAllTimersAsync();
    expect(svc.getState().phase).toBe("drained");

    const result = await svc.resume({ actorId: "u", actorType: "user" });
    expect(result.phase).toBe("idle");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "system.shutdown.resumed" }),
    );
  });

  it("resume errors when phase is idle", async () => {
    const svc = shutdownService(makeDb({ pausedRows: [], inFlightRows: [], shutdownPausedRows: [] }) as never);
    await expect(svc.resume({ actorId: "u", actorType: "user" })).rejects.toThrow(
      /No active shutdown/i,
    );
  });
});
