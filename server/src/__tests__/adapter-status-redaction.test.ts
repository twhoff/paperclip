import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { adapterStatusService } from "../services/adapter-status.js";

const mockFindServerAdapter = vi.hoisted(() => vi.fn());
const mockResolveAdapterConfigForRuntime = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: mockLoggerWarn },
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveAdapterConfigForRuntime: mockResolveAdapterConfigForRuntime,
  }),
}));

function createDbHarness(
  adapterConfig: Record<string, unknown> = {},
  options: {
    persistError?: unknown;
    probingTypes?: string[];
  } = {},
) {
  let stored: Record<string, unknown> | null = null;
  const db = {
    select(selection?: unknown) {
      const query: Record<string, any> = {};
      query.from = vi.fn(() => query);
      query.where = vi.fn(() => query);
      query.orderBy = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.then = (
        resolve: (rows: Array<Record<string, unknown>>) => unknown,
        reject?: (error: unknown) => unknown,
      ) => {
        const selectionKeys = selection && typeof selection === "object"
          ? Object.keys(selection as Record<string, unknown>)
          : [];
        const rows = selectionKeys.includes("companyId")
          ? [{ companyId: "company-1", adapterConfig }]
          : selectionKeys.length === 1 && selectionKeys[0] === "adapterType"
            ? (options.probingTypes ?? []).map((adapterType) => ({ adapterType }))
            : stored
              ? [stored]
              : [];
        return Promise.resolve(rows).then(resolve, reject);
      };
      return query;
    },
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        stored = { ...(stored ?? {}), ...values };
        return {
          onConflictDoUpdate: vi.fn(async ({ set }: { set: Record<string, unknown> }) => {
            if (options.persistError !== undefined) throw options.persistError;
            stored = { ...(stored ?? {}), ...set };
          }),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () =>
            (options.probingTypes ?? []).map((adapterType) => ({ adapterType }))),
        })),
      })),
    })),
  };

  return {
    db: db as unknown as Db,
    stored: () => stored,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
});

describe("adapter status probe redaction", () => {
  beforeEach(() => {
    mockResolveAdapterConfigForRuntime.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => ({
        config,
        secretKeys: new Set<string>(),
      }),
    );
  });

  it.each(["result", "exception"] as const)(
    "redacts provider credentials from scheduled probe %s persistence and status retrieval",
    async (source) => {
      const providerCredential = `adapter-status-${source}-credential-canary-58c9`;
      process.env.ANTHROPIC_API_KEY = providerCredential;
      const testEnvironment = source === "result"
        ? vi.fn().mockResolvedValue({
            adapterType: "claude_local",
            status: "fail",
            checks: [
              {
                code: "provider_probe_failed",
                level: "error",
                message: `provider stderr contained ${providerCredential}`,
              },
            ],
            testedAt: new Date().toISOString(),
          })
        : vi.fn().mockRejectedValue(
            new Error(`provider probe threw with ${providerCredential}`),
          );
      mockFindServerAdapter.mockReturnValue({ testEnvironment });
      const harness = createDbHarness();
      const service = adapterStatusService(harness.db);

      const probeResult = await service.probeAdapterHealth("claude_local");
      const retrievedStatus = await service.getByType("claude_local");
      const surfaces = JSON.stringify({
        probeResult,
        stored: harness.stored(),
        retrievedStatus,
      });

      expect(retrievedStatus).toMatchObject({
        adapterType: "claude_local",
        status: "offline",
        lastProbeStatus: "fail",
      });
      expect(surfaces).not.toContain(providerCredential);
      expect(surfaces).toContain("***REDACTED***");
    },
  );

  it.each(["result", "exception"] as const)(
    "resolves secret-ref config and redacts echoed scheduled probe %s diagnostics",
    async (source) => {
      const providerCredential = `resolved-probe-${source}-credential-7e91`;
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
      const testEnvironment = vi.fn(async (input: { config: Record<string, unknown> }) => {
        expect(input.config).toEqual(runtimeConfig);
        if (source === "exception") {
          throw new Error(`resolved provider threw with ${providerCredential}`);
        }
        return {
          adapterType: "claude_local",
          status: "fail" as const,
          checks: [{
            code: "provider_probe_failed",
            level: "error" as const,
            message: `resolved provider echoed ${providerCredential}`,
          }],
          testedAt: new Date().toISOString(),
        };
      });
      mockFindServerAdapter.mockReturnValue({ testEnvironment });
      const harness = createDbHarness(persistedConfig);
      const service = adapterStatusService(harness.db);

      const probeResult = await service.probeAdapterHealth("claude_local");
      const retrievedStatus = await service.getByType("claude_local");
      const surfaces = JSON.stringify({
        probeResult,
        stored: harness.stored(),
        retrievedStatus,
      });

      expect(mockResolveAdapterConfigForRuntime).toHaveBeenCalledWith(
        "company-1",
        persistedConfig,
      );
      expect(testEnvironment).toHaveBeenCalledOnce();
      expect(surfaces).not.toContain(providerCredential);
      expect(surfaces).toContain("***REDACTED***");
    },
  );

  it("records a sanitized probe failure when secret resolution rejects", async () => {
    const providerCredential = "adapter-resolution-failure-secret-5197";
    process.env.ANTHROPIC_API_KEY = providerCredential;
    mockResolveAdapterConfigForRuntime.mockRejectedValue(
      new Error(`decrypt failed for ${providerCredential}`),
    );
    const testEnvironment = vi.fn();
    mockFindServerAdapter.mockReturnValue({ testEnvironment });
    const harness = createDbHarness({
      env: {
        BENIGN_SETTING: {
          type: "secret_ref",
          secretId: "44444444-4444-4444-8444-444444444444",
        },
      },
    });
    const service = adapterStatusService(harness.db);

    const probeResult = await service.probeAdapterHealth("claude_local");
    const retrievedStatus = await service.getByType("claude_local");
    const surfaces = JSON.stringify({ probeResult, stored: harness.stored(), retrievedStatus });

    expect(testEnvironment).not.toHaveBeenCalled();
    expect(probeResult).toMatchObject({
      status: "fail",
      checks: [{ code: "probe_error", level: "error" }],
    });
    expect(retrievedStatus).toMatchObject({
      status: "offline",
      lastProbeStatus: "fail",
    });
    expect(surfaces).not.toContain(providerCredential);
    expect(surfaces).toContain("adapter configuration could not be resolved");
  });

  it("normalizes a malformed projected checks shape to a bounded failure", async () => {
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockResolvedValue({
        adapterType: "claude_local",
        status: "pass",
        checks: { 0: { code: "unsafe", level: "info", message: "unsafe" }, length: 1 },
        testedAt: new Date().toISOString(),
      }),
    });
    const service = adapterStatusService(createDbHarness().db);

    const result = await service.probeAdapterHealth("claude_local");

    expect(result).toMatchObject({
      adapterType: "claude_local",
      status: "fail",
      checks: [{ code: "probe_error", level: "error" }],
    });
  });

  it("does not invoke a hostile non-Error rejection stringifier", async () => {
    const hostile = {
      toString() {
        throw new Error("hostile stringifier invoked");
      },
    };
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockRejectedValue(hostile),
    });
    const service = adapterStatusService(createDbHarness().db);

    const result = await service.probeAdapterHealth("claude_local");

    expect(result).toMatchObject({
      status: "fail",
      checks: [{ code: "probe_error", message: "adapter probe failed" }],
    });
  });

  it("fails probe diagnostics closed when configured-secret collection overflows", async () => {
    const adapterConfig = {
      env: Object.fromEntries(
        Array.from({ length: 129 }, (_, index) => [
          `API_KEY_${index}`,
          `configured-probe-secret-${index}`,
        ]),
      ),
    };
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockResolvedValue({
        adapterType: "claude_local",
        status: "pass",
        checks: [{ code: "ok", level: "info", message: "nominal probe detail" }],
        testedAt: new Date().toISOString(),
      }),
    });
    const harness = createDbHarness(adapterConfig);
    const service = adapterStatusService(harness.db);

    const result = await service.probeAdapterHealth("claude_local");
    const surfaces = JSON.stringify({ result, stored: harness.stored() });

    expect(surfaces).not.toContain("nominal probe detail");
    expect(surfaces).toContain("***REDACTED***");
  });

  it("aborts a hung adapter probe at its deadline", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const testEnvironment = vi.fn(
      (input: { signal?: AbortSignal }) => new Promise<AdapterEnvironmentTestResult>((_resolve, reject) => {
        observedSignal = input.signal;
        input.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("probe aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    mockFindServerAdapter.mockReturnValue({ testEnvironment });
    const service = adapterStatusService(createDbHarness().db);

    const pending = service.probeAdapterHealth("claude_local");
    await vi.advanceTimersByTimeAsync(0);
    expect(testEnvironment).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "fail",
      checks: [{ code: "probe_error", level: "error" }],
    });
  });

  it("runs overlapping scheduled ticks as a single flight", async () => {
    let resolveProbe!: (value: AdapterEnvironmentTestResult) => void;
    const pendingProbe = new Promise<AdapterEnvironmentTestResult>((resolve) => {
      resolveProbe = resolve;
    });
    const testEnvironment = vi.fn(() => pendingProbe);
    mockFindServerAdapter.mockReturnValue({ testEnvironment });
    const harness = createDbHarness({}, { probingTypes: ["claude_local"] });
    const service = adapterStatusService(harness.db);

    const first = service.runScheduledProbeCycle();
    const second = service.runScheduledProbeCycle();
    await vi.waitFor(() => expect(testEnvironment).toHaveBeenCalled());
    resolveProbe({
      adapterType: "claude_local",
      status: "pass",
      checks: [{ code: "ok", level: "info", message: "ok" }],
      testedAt: new Date().toISOString(),
    });
    await Promise.all([first, second]);

    expect(testEnvironment).toHaveBeenCalledOnce();
  });

  it("does not attach raw scheduled-probe failures to the outer logger", async () => {
    const credential = "scheduled-probe-logger-secret-a491";
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockResolvedValue({
        adapterType: "claude_local",
        status: "pass",
        checks: [{ code: "ok", level: "info", message: "ok" }],
        testedAt: new Date().toISOString(),
      }),
    });
    const harness = createDbHarness(
      {},
      {
        probingTypes: ["claude_local"],
        persistError: new Error(`database failed with ${credential}`),
      },
    );
    const service = adapterStatusService(harness.db);

    const result = await service.runScheduledProbes();

    expect(result.failed).toEqual(["claude_local"]);
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(mockLoggerWarn.mock.calls[0]?.[0]).not.toHaveProperty("err");
    expect(String(mockLoggerWarn.mock.calls)).not.toContain(credential);
  });
});
