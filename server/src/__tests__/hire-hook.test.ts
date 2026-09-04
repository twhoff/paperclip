import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { notifyHireApproved } from "../services/hire-hook.js";

const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockResolveAdapterConfigForRuntime = vi.hoisted(() => vi.fn());

// Mock the registry so we control whether the adapter has onHireApproved and what it does.
vi.mock("../adapters/registry.js", () => ({
  findServerAdapter: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: mockLoggerWarn, error: mockLoggerError },
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveAdapterConfigForRuntime: mockResolveAdapterConfigForRuntime,
  }),
}));

const { findServerAdapter } = await import("../adapters/registry.js");
const { logActivity } = await import("../services/activity-log.js");

function mockDbWithAgent(agent: { id: string; companyId: string; name: string; adapterType: string; adapterConfig?: Record<string, unknown> }): Db {
  return {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: agent.id,
              companyId: agent.companyId,
              name: agent.name,
              adapterType: agent.adapterType,
              adapterConfig: agent.adapterConfig ?? {},
            },
          ]),
      }),
    }),
  } as unknown as Db;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("notifyHireApproved", () => {
  beforeEach(() => {
    mockResolveAdapterConfigForRuntime.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => ({
        config,
        secretKeys: new Set<string>(),
      }),
    );
  });

  it("writes success activity when adapter hook returns ok", async () => {
    vi.mocked(findServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockResolvedValue({ ok: true }),
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.succeeded",
        entityId: "a1",
        details: expect.objectContaining({ source: "approval", sourceId: "ap1", adapterType: "openclaw_gateway" }),
      }),
    );
  });

  it("does nothing when agent is not found", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    } as unknown as Db;

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(findServerAdapter).not.toHaveBeenCalled();
  });

  it("does nothing when adapter has no onHireApproved", async () => {
    vi.mocked(findServerAdapter).mockReturnValue({ type: "process" } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "Agent",
      adapterType: "process",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      }),
    ).resolves.toBeUndefined();

    expect(findServerAdapter).toHaveBeenCalledWith("process");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("logs failed result when adapter onHireApproved returns ok=false", async () => {
    vi.mocked(findServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockResolvedValue({ ok: false, error: "HTTP 500", detail: { status: 500 } }),
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.failed",
        entityId: "a1",
        details: expect.objectContaining({ source: "join_request", sourceId: "jr1", error: "HTTP 500" }),
      }),
    );
  });

  it("redacts a provider credential split across failed hook fields before log and activity boundaries", async () => {
    const providerCredential = "hire-hook-cross-field-credential-canary-f275";
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = providerCredential;
    const splitAt = 19;
    vi.mocked(findServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockResolvedValue({
        ok: false,
        error: providerCredential.slice(0, splitAt),
        detail: { diagnostic: providerCredential.slice(splitAt) },
      }),
    } as any);
    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    try {
      await notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "approval",
        sourceId: "ap1",
      });

      const logged = mockLoggerWarn.mock.calls.at(-1)?.[0] as any;
      const activity = vi.mocked(logActivity).mock.calls.at(-1)?.[1] as any;
      const loggedReconstruction = `${logged.error}${logged.detail.diagnostic}`;
      const activityReconstruction = `${activity.details.error}${activity.details.detail.diagnostic}`;
      expect(loggedReconstruction).not.toContain(providerCredential);
      expect(activityReconstruction).not.toContain(providerCredential);
      expect(JSON.stringify({ logged, activity })).toContain("***REDACTED***");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("does not throw when adapter onHireApproved throws (non-fatal)", async () => {
    vi.mocked(findServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockRejectedValue(new Error("Network error")),
    } as any);

    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(
      notifyHireApproved(db, {
        companyId: "c1",
        agentId: "a1",
        source: "join_request",
        sourceId: "jr1",
      }),
    ).resolves.toBeUndefined();

    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "hire_hook.error",
        entityId: "a1",
        details: expect.objectContaining({ source: "join_request", sourceId: "jr1", error: "Network error" }),
      }),
    );
  });

  it("does not throw when a rejected hook value has a hostile string conversion", async () => {
    vi.mocked(findServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockRejectedValue({
        toString() {
          throw new Error("must not stringify");
        },
      }),
    } as any);
    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(notifyHireApproved(db, {
      companyId: "c1",
      agentId: "a1",
      source: "join_request",
      sourceId: "jr1",
    })).resolves.toBeUndefined();

    expect(mockLoggerError.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        err: { name: "Error", message: "Adapter hire hook failed" },
      }),
    );
  });

  it("does not throw for hostile or non-string Error diagnostic fields", async () => {
    const thrown = new Error("ignored") as Error & { message: unknown };
    Object.defineProperty(thrown, "name", {
      get() {
        throw new Error("must not read name");
      },
    });
    Object.defineProperty(thrown, "message", { value: 42 });
    vi.mocked(findServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockRejectedValue(thrown),
    } as any);
    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
    });

    await expect(notifyHireApproved(db, {
      companyId: "c1",
      agentId: "a1",
      source: "approval",
      sourceId: "ap1",
    })).resolves.toBeUndefined();

    expect(mockLoggerError.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        err: { name: "Error", message: "Adapter hire hook failed" },
      }),
    );
  });

  it("resolves secret-ref config before the hook and redacts an echoed resolved credential", async () => {
    const providerCredential = "hire-hook-resolved-benign-secret-42";
    const persistedConfig = {
      env: {
        BENIGN_SETTING: {
          type: "secret_ref",
          secretId: "33333333-3333-4333-8333-333333333333",
        },
      },
    };
    const runtimeConfig = { env: { BENIGN_SETTING: providerCredential } };
    mockResolveAdapterConfigForRuntime.mockResolvedValue({
      config: runtimeConfig,
      secretKeys: new Set(["BENIGN_SETTING"]),
    });
    const onHireApproved = vi.fn(async (_payload, config) => {
      expect(config).toEqual(runtimeConfig);
      return {
        ok: false as const,
        error: `provider rejected ${providerCredential}`,
        detail: { diagnostic: `echo ${providerCredential}` },
      };
    });
    vi.mocked(findServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved,
    } as any);
    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      adapterConfig: persistedConfig,
    });

    await notifyHireApproved(db, {
      companyId: "c1",
      agentId: "a1",
      source: "approval",
      sourceId: "ap1",
    });

    const logged = mockLoggerWarn.mock.calls.at(-1)?.[0];
    const activity = vi.mocked(logActivity).mock.calls.at(-1)?.[1];
    expect(mockResolveAdapterConfigForRuntime).toHaveBeenCalledWith("c1", persistedConfig);
    expect(onHireApproved).toHaveBeenCalledOnce();
    expect(JSON.stringify({ logged, activity })).not.toContain(providerCredential);
    expect(JSON.stringify({ logged, activity })).toContain("***REDACTED***");
  });

  it("redacts a resolved credential split across a thrown error name and message", async () => {
    const providerCredential = "hire-hook-thrown-split-secret-42";
    const splitAt = 16;
    const persistedConfig = {
      env: {
        BENIGN_SETTING: {
          type: "secret_ref",
          secretId: "33333333-3333-4333-8333-333333333333",
        },
      },
    };
    mockResolveAdapterConfigForRuntime.mockResolvedValue({
      config: { env: { BENIGN_SETTING: providerCredential } },
      secretKeys: new Set(["BENIGN_SETTING"]),
    });
    const thrown = new Error(providerCredential.slice(splitAt));
    thrown.name = providerCredential.slice(0, splitAt);
    vi.mocked(findServerAdapter).mockReturnValue({
      type: "openclaw_gateway",
      onHireApproved: vi.fn().mockRejectedValue(thrown),
    } as any);
    const db = mockDbWithAgent({
      id: "a1",
      companyId: "c1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      adapterConfig: persistedConfig,
    });

    await expect(notifyHireApproved(db, {
      companyId: "c1",
      agentId: "a1",
      source: "approval",
      sourceId: "ap1",
    })).resolves.toBeUndefined();

    const logged = mockLoggerError.mock.calls.at(-1)?.[0] as any;
    const activity = vi.mocked(logActivity).mock.calls.at(-1)?.[1] as any;
    const loggedReconstruction = `${logged.err.name}${logged.err.message}`;
    expect(loggedReconstruction).not.toContain(providerCredential);
    expect(JSON.stringify({ logged, activity })).not.toContain(providerCredential);
    expect(JSON.stringify({ logged, activity })).toContain("***REDACTED***");
  });
});
