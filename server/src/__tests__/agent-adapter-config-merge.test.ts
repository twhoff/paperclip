import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    name: "Builder",
    urlKey: "builder",
    role: "engineer",
    title: "Builder",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-4-20250514",
      dangerouslySkipPermissions: true,
      allowAll: true,
      cwd: "/Users/test/project",
      instructionsFilePath: "/Users/test/project/AGENTS.md",
    },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-03-19T00:00:00.000Z"),
    updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    ...overrides,
  };
}

let capturedUpdatePatch: Record<string, unknown> | null = null;
let capturedRouteError: unknown = null;
let capturedErrorContext: unknown = null;

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAdapterStatusService = vi.hoisted(() => ({
  resetExpiredStatuses: vi.fn(),
  listAll: vi.fn(),
  getByType: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());
const mockListAdapterModels = vi.hoisted(() => vi.fn());
const mockRunClaudeLogin = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  getRuntimeState: vi.fn(),
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  wakeup: vi.fn(),
  invoke: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForRun: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  adapterStatusService: () => mockAdapterStatusService,
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({
    materializeManagedBundle: vi.fn(),
    getBundle: vi.fn(),
    updateBundle: vi.fn(),
  }),
  accessService: () => mockAccessService,
  approvalService: () => ({ create: vi.fn(), getById: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillKeys: vi.fn(),
  }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({ list: vi.fn() }),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: mockListAdapterModels,
}));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  runClaudeLogin: mockRunClaudeLogin,
}));

vi.mock("@paperclipai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([
            {
              id: companyId,
              name: "Paperclip",
              requireBoardApprovalForNewAgents: false,
            },
          ]),
        }),
      }),
    }),
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    capturedRouteError = err;
    errorHandler(err, req, res, next);
    capturedErrorContext = (res as any).__errorContext ?? null;
  });
  return app;
}

describe("PATCH /api/agents/:id — adapterConfig merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedUpdatePatch = null;
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => {
        capturedUpdatePatch = patch;
        return { ...makeAgent(), ...patch };
      },
    );
  });

  it("preserves private fields when adapterConfig is partially patched", async () => {
    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { model: "gpt-5.4" } });

    expect(res.status).toBe(200);
    const saved = capturedUpdatePatch?.adapterConfig as Record<string, unknown>;
    expect(saved).toBeDefined();
    expect(saved.model).toBe("gpt-5.4");
    expect(saved.dangerouslySkipPermissions).toBe(true);
    expect(saved.allowAll).toBe(true);
    expect(saved.cwd).toBe("/Users/test/project");
  });

  it("preserves private fields when adapter type changes", async () => {
    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "copilot_cli",
        adapterConfig: { model: "claude-sonnet-4-20250514" },
      });

    expect(res.status).toBe(200);
    const saved = capturedUpdatePatch?.adapterConfig as Record<string, unknown>;
    expect(saved).toBeDefined();
    expect(saved.model).toBe("claude-sonnet-4-20250514");
    expect(saved.dangerouslySkipPermissions).toBe(true);
    expect(saved.allowAll).toBe(true);
    expect(saved.cwd).toBe("/Users/test/project");
  });

  it("defaults dangerouslySkipPermissions when switching into claude_local", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({
        adapterType: "codex_local",
        adapterConfig: {
          model: "codex-mini-latest",
          dangerouslyBypassApprovalsAndSandbox: true,
          cwd: "/Users/test/project",
        },
      }),
    );

    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "claude_local",
        adapterConfig: { model: "claude-sonnet-4-20250514" },
      });

    expect(res.status).toBe(200);
    const saved = capturedUpdatePatch?.adapterConfig as Record<string, unknown>;
    expect(saved).toBeDefined();
    expect(saved.model).toBe("claude-sonnet-4-20250514");
    expect(saved.dangerouslySkipPermissions).toBe(true);
    expect(saved.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(saved.cwd).toBe("/Users/test/project");
  });

  it("defaults allowAll when switching into copilot_cli", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4-20250514",
          dangerouslySkipPermissions: true,
          cwd: "/Users/test/project",
        },
      }),
    );

    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "copilot_cli",
        adapterConfig: { model: "claude-sonnet-4-20250514" },
      });

    expect(res.status).toBe(200);
    const saved = capturedUpdatePatch?.adapterConfig as Record<string, unknown>;
    expect(saved).toBeDefined();
    expect(saved.model).toBe("claude-sonnet-4-20250514");
    expect(saved.dangerouslySkipPermissions).toBe(true);
    expect(saved.allowAll).toBe(true);
    expect(saved.cwd).toBe("/Users/test/project");
  });

  it("allows overlay to override an existing private field", async () => {
    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          model: "claude-sonnet-4-20250514",
          dangerouslySkipPermissions: false,
        },
      });

    expect(res.status).toBe(200);
    const saved = capturedUpdatePatch?.adapterConfig as Record<string, unknown>;
    expect(saved.dangerouslySkipPermissions).toBe(false);
    expect(saved.allowAll).toBe(true);
  });

  it("preserves codex_local dangerouslyBypassApprovalsAndSandbox", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({
        adapterType: "codex_local",
        adapterConfig: {
          model: "codex-mini-latest",
          dangerouslyBypassApprovalsAndSandbox: true,
          cwd: "/Users/test/project",
        },
      }),
    );

    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { model: "o4-mini" } });

    expect(res.status).toBe(200);
    const saved = capturedUpdatePatch?.adapterConfig as Record<string, unknown>;
    expect(saved.model).toBe("o4-mini");
    expect(saved.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(saved.cwd).toBe("/Users/test/project");
  });

  it("does not touch adapterConfig when only runtimeConfig is patched", async () => {
    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { heartbeat: { enabled: false } } });

    expect(res.status).toBe(200);
    // adapterConfig should not be in the patch at all
    expect(capturedUpdatePatch).not.toHaveProperty("adapterConfig");
  });

  it("preserves existing config when only adapterType changes (no adapterConfig in patch)", async () => {
    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterType: "copilot_cli" });

    expect(res.status).toBe(200);
    const saved = capturedUpdatePatch?.adapterConfig as Record<string, unknown>;
    expect(saved).toBeDefined();
    expect(saved.dangerouslySkipPermissions).toBe(true);
    expect(saved.allowAll).toBe(true);
    expect(saved.model).toBe("claude-sonnet-4-20250514");
  });

  it("masks stored plain config values and diagnostics in an agent detail response", async () => {
    const storedSecret = "stored-provider-secret-detail-7842";
    const diagnosticToken = "eyJagent.payload.signature_detail";
    const storedAgent = makeAgent({
      adapterConfig: {
        model: "claude-sonnet-4-20250514",
        env: {
          BENIGN_SETTING: { type: "plain", value: storedSecret },
        },
      },
      runtimeConfig: {
        env: {
          RUNTIME_DISPLAY_VALUE: { type: "plain", value: storedSecret },
        },
      },
      metadata: { message: diagnosticToken },
    });
    mockAgentService.getById.mockResolvedValue(storedAgent);

    const response = await request(createApp()).get(`/api/agents/${agentId}`);

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(storedSecret);
    expect(JSON.stringify(response.body)).not.toContain(diagnosticToken);
    expect(response.body).toMatchObject({
      id: agentId,
      companyId,
      name: "Builder",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-4-20250514",
        env: {
          BENIGN_SETTING: { type: "plain", value: "***REDACTED***" },
        },
      },
      runtimeConfig: {
        env: {
          RUNTIME_DISPLAY_VALUE: { type: "plain", value: "***REDACTED***" },
        },
      },
      metadata: { message: "***REDACTED***" },
    });
    expect((storedAgent.adapterConfig as any).env.BENIGN_SETTING.value).toBe(storedSecret);
  });

  it("masks stored plain config values in the config-readable agent list", async () => {
    const storedSecret = "stored-provider-secret-list-1935";
    mockAgentService.list.mockResolvedValue([
      makeAgent({
        adapterConfig: {
          model: "claude-sonnet-4-20250514",
          env: {
            BENIGN_SETTING: { type: "plain", value: storedSecret },
          },
        },
        runtimeConfig: {
          env: {
            RUNTIME_DISPLAY_VALUE: { type: "plain", value: storedSecret },
          },
        },
      }),
    ]);

    const response = await request(createApp()).get(`/api/companies/${companyId}/agents`);

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(storedSecret);
    expect(response.body[0]).toMatchObject({
      id: agentId,
      adapterConfig: {
        env: { BENIGN_SETTING: { type: "plain", value: "***REDACTED***" } },
      },
      runtimeConfig: {
        env: { RUNTIME_DISPLAY_VALUE: { type: "plain", value: "***REDACTED***" } },
      },
    });
  });

  it("masks stored config in mutation responses without changing the service input", async () => {
    const storedSecret = "stored-provider-secret-mutation-5526";
    const storedAgent = makeAgent({
      adapterConfig: {
        model: "claude-sonnet-4-20250514",
        env: {
          BENIGN_SETTING: { type: "plain", value: storedSecret },
        },
      },
    });
    mockAgentService.getById.mockResolvedValue(storedAgent);
    mockAgentService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => {
        capturedUpdatePatch = patch;
        return { ...storedAgent, ...patch };
      },
    );

    const response = await request(createApp())
      .patch(`/api/agents/${agentId}`)
      .send({ title: "Updated Builder" });

    expect(response.status).toBe(200);
    expect(capturedUpdatePatch).toEqual({ title: "Updated Builder" });
    expect(response.body).toMatchObject({
      id: agentId,
      title: "Updated Builder",
      adapterConfig: {
        env: { BENIGN_SETTING: { type: "plain", value: "***REDACTED***" } },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(storedSecret);
    expect((storedAgent.adapterConfig as any).env.BENIGN_SETTING.value).toBe(storedSecret);
  });
});

describe("adapter diagnostic result redaction", () => {
  const resolvedSecret = "resolved-benign-binding-value-42";
  const resolvedConfig = {
    command: process.execPath,
    env: {
      BENIGN_SETTING: resolvedSecret,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedRouteError = null;
    capturedErrorContext = null;
    mockAgentService.getById.mockResolvedValue(
      makeAgent({
        adapterConfig: {
          env: {
            BENIGN_SETTING: {
              type: "secret_ref",
              secretId: "33333333-3333-4333-8333-333333333333",
            },
          },
        },
      }),
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_company: string, config: Record<string, unknown>) => config,
    );
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: resolvedConfig,
      secretKeys: new Set(["BENIGN_SETTING"]),
    });
  });

  it("redacts resolved benign-key secrets from test-environment results", async () => {
    const splitAt = 17;
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockResolvedValue({
        status: "warn",
        stdout: `probe echoed ${resolvedSecret.slice(0, splitAt)}`,
        stderr: `${resolvedSecret.slice(splitAt)} while checking`,
      }),
    });

    const response = await request(createApp())
      .post(`/api/companies/${companyId}/adapters/claude_local/test-environment`)
      .send({
        adapterConfig: {
          env: {
            BENIGN_SETTING: {
              type: "secret_ref",
              secretId: "33333333-3333-4333-8333-333333333333",
            },
          },
        },
      });

    expect(response.status).toBe(200);
    expect(`${response.body.stdout}${response.body.stderr}`).not.toContain(resolvedSecret);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("redacts resolved benign-key secrets from Claude login results", async () => {
    const splitAt = 17;
    mockRunClaudeLogin.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: `login stdout ${resolvedSecret.slice(0, splitAt)}`,
      stderr: `${resolvedSecret.slice(splitAt)} login stderr`,
    });

    const response = await request(createApp())
      .post(`/api/agents/${agentId}/claude-login`)
      .send({});

    expect(response.status).toBe(200);
    expect(`${response.body.stdout}${response.body.stderr}`).not.toContain(resolvedSecret);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("redacts a plain sensitive environment value from test-environment results", async () => {
    const plainSecret = "plain-test-environment-secret-6194";
    const splitAt = 16;
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: { env: { ANTHROPIC_API_KEY: plainSecret } },
      secretKeys: new Set<string>(),
    });
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockResolvedValue({
        status: "warn",
        stdout: plainSecret.slice(0, splitAt),
        stderr: plainSecret.slice(splitAt),
      }),
    });

    const response = await request(createApp())
      .post(`/api/companies/${companyId}/adapters/claude_local/test-environment`)
      .send({ adapterConfig: { env: { ANTHROPIC_API_KEY: plainSecret } } });

    expect(response.status).toBe(200);
    expect(`${response.body.stdout}${response.body.stderr}`).not.toContain(plainSecret);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("redacts a plain sensitive environment value from Claude login results", async () => {
    const plainSecret = "plain-claude-login-secret-2753";
    const splitAt = 14;
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: { env: { ANTHROPIC_API_KEY: plainSecret } },
      secretKeys: new Set<string>(),
    });
    mockRunClaudeLogin.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: plainSecret.slice(0, splitAt),
      stderr: plainSecret.slice(splitAt),
    });

    const response = await request(createApp())
      .post(`/api/agents/${agentId}/claude-login`)
      .send({});

    expect(response.status).toBe(200);
    expect(`${response.body.stdout}${response.body.stderr}`).not.toContain(plainSecret);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("redacts a resolved secret split across fields of a non-Error rejection", async () => {
    const splitAt = 19;
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockRejectedValue({
        left: resolvedSecret.slice(0, splitAt),
        right: resolvedSecret.slice(splitAt),
      }),
    });

    const response = await request(createApp())
      .post(`/api/companies/${companyId}/adapters/claude_local/test-environment`)
      .send({ adapterConfig: {} });
    const routeError = capturedRouteError as { left: string; right: string };

    expect(response.status).toBe(500);
    expect(`${routeError.left}${routeError.right}`).not.toContain(resolvedSecret);
    expect(JSON.stringify(routeError)).toContain("***REDACTED***");
  });

  it("redacts resolved benign-key secrets from rejected test-environment diagnostics before error logging", async () => {
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockRejectedValue(
        new Error(`provider probe failed with ${resolvedSecret}`),
      ),
    });

    const response = await request(createApp())
      .post(`/api/companies/${companyId}/adapters/claude_local/test-environment`)
      .send({
        adapterConfig: {
          env: {
            BENIGN_SETTING: {
              type: "secret_ref",
              secretId: "33333333-3333-4333-8333-333333333333",
            },
          },
        },
      });

    const routeError = capturedRouteError as Error;
    const logSurface = JSON.stringify({
      routeError: {
        name: routeError.name,
        message: routeError.message,
        stack: routeError.stack,
      },
      errorContext: capturedErrorContext,
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(resolvedSecret);
    expect(logSurface).not.toContain(resolvedSecret);
    expect(logSurface).toContain("***REDACTED***");
  });

  it("redacts a resolved benign-key secret from OpenCode validation errors", async () => {
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: {
        model: "provider/model",
        command: process.execPath,
        env: { BENIGN_SETTING: resolvedSecret },
      },
      secretKeys: new Set(["BENIGN_SETTING"]),
    });
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockRejectedValue(
      new Error(`available provider model exposed ${resolvedSecret}`),
    );

    const response = await request(createApp())
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "opencode_local",
        adapterConfig: {
          model: "provider/model",
          env: {
            BENIGN_SETTING: {
              type: "secret_ref",
              secretId: "33333333-3333-4333-8333-333333333333",
            },
          },
        },
      });

    const routeError = capturedRouteError as Error;
    const surface = JSON.stringify({ response: response.body, routeError });
    expect(response.status).toBe(422);
    expect(surface).not.toContain(resolvedSecret);
    expect(surface).toContain("***REDACTED***");
  });

  it("preserves rejected Claude login HTTP status while redacting resolved secrets from response and error context", async () => {
    mockRunClaudeLogin.mockRejectedValue(
      new HttpError(
        429,
        `provider login throttled for ${resolvedSecret}`,
        { providerDetail: `retry credential ${resolvedSecret}` },
      ),
    );

    const response = await request(createApp())
      .post(`/api/agents/${agentId}/claude-login`)
      .send({});

    const routeError = capturedRouteError as HttpError;
    const logSurface = JSON.stringify({
      routeError: {
        status: routeError.status,
        name: routeError.name,
        message: routeError.message,
        stack: routeError.stack,
        details: routeError.details,
      },
      errorContext: capturedErrorContext,
    });

    expect(response.status).toBe(429);
    expect(JSON.stringify(response.body)).not.toContain(resolvedSecret);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
    expect(routeError.status).toBe(429);
    expect(logSurface).not.toContain(resolvedSecret);
    expect(logSurface).toContain("***REDACTED***");
  });

  it("redacts a resolved secret split between rejected login message and details", async () => {
    const splitAt = 18;
    mockRunClaudeLogin.mockRejectedValue(
      new HttpError(
        429,
        `provider login failed: ${resolvedSecret.slice(0, splitAt)}`,
        { diagnostic: resolvedSecret.slice(splitAt) },
      ),
    );

    const response = await request(createApp())
      .post(`/api/agents/${agentId}/claude-login`)
      .send({});

    const routeError = capturedRouteError as HttpError;
    const routeDetails = routeError.details as { diagnostic: string };
    const responseReconstruction = `${response.body.error}${response.body.details.diagnostic}`;
    const routeReconstruction = `${routeError.message}${routeDetails.diagnostic}`;
    const contextError = (capturedErrorContext as any).error;
    const contextReconstruction = `${contextError.message}${contextError.details.diagnostic}`;

    expect(response.status).toBe(429);
    expect(routeError.status).toBe(429);
    expect(responseReconstruction).not.toContain(resolvedSecret);
    expect(routeReconstruction).not.toContain(resolvedSecret);
    expect(contextReconstruction).not.toContain(resolvedSecret);
    expect(JSON.stringify({ response: response.body, routeError, contextError }))
      .toContain("***REDACTED***");
  });

  it("bounds cyclic rejected login details before response and error logging", async () => {
    const details: Record<string, unknown> = {
      diagnostic: `provider login failed with ${resolvedSecret}`,
    };
    details.self = details;
    mockRunClaudeLogin.mockRejectedValue(
      new HttpError(429, `provider login throttled for ${resolvedSecret}`, details),
    );

    const response = await request(createApp())
      .post(`/api/agents/${agentId}/claude-login`)
      .send({});

    const routeError = capturedRouteError as HttpError;
    const logSurface = JSON.stringify({
      response: response.body,
      routeError: {
        message: routeError.message,
        details: routeError.details,
      },
      errorContext: capturedErrorContext,
    });

    expect(response.status).toBe(429);
    expect(logSurface).not.toContain(resolvedSecret);
    expect(logSurface).toContain("***REDACTED***");
  });

  it("fails closed when rejected login error accessors throw", async () => {
    const rejected = new Proxy(new HttpError(429, "hidden", { diagnostic: "hidden" }), {
      get(target, property, receiver) {
        if (["name", "message", "stack", "details"].includes(String(property))) {
          throw new Error(`hostile adapter accessor ${resolvedSecret}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    mockRunClaudeLogin.mockRejectedValue(rejected);

    const response = await request(createApp())
      .post(`/api/agents/${agentId}/claude-login`)
      .send({});

    const routeError = capturedRouteError as HttpError;
    const surface = JSON.stringify({ response: response.body, routeError, capturedErrorContext });
    expect(response.status).toBe(429);
    expect(surface).not.toContain(resolvedSecret);
    expect(surface).toContain("***REDACTED***");
  });

  it("redacts current provider credentials from discovered model fields", async () => {
    const previous = process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN;
    process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN = resolvedSecret;
    mockListAdapterModels.mockResolvedValue([
      {
        id: "safe-model-id",
        label: `Provider model ${resolvedSecret}`,
      },
    ]);

    try {
      const response = await request(createApp())
        .get(`/api/companies/${companyId}/adapters/claude_local/models`);

      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(resolvedSecret);
      expect(JSON.stringify(response.body)).toContain("***REDACTED***");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN;
      else process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN = previous;
    }
  });

  it("redacts credentials split across arbitrary discovered model fields while preserving benign models", async () => {
    const previous = process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN;
    process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN = resolvedSecret;
    const firstSplit = 12;
    const secondSplit = 24;
    mockListAdapterModels.mockResolvedValue([
      {
        id: resolvedSecret.slice(0, firstSplit),
        label: resolvedSecret.slice(firstSplit, secondSplit),
        name: resolvedSecret.slice(secondSplit),
        description: "benign description",
      },
      {
        id: "safe-model-id",
        label: "Safe model",
        name: "safe-model",
        description: "Safe description",
      },
    ]);

    try {
      const response = await request(createApp())
        .get(`/api/companies/${companyId}/adapters/claude_local/models`);

      const hostileModel = response.body[0];
      const reconstructed = `${hostileModel.id}${hostileModel.label}${hostileModel.name}`;
      expect(response.status).toBe(200);
      expect(reconstructed).not.toContain(resolvedSecret);
      expect(JSON.stringify(hostileModel)).toContain("***REDACTED***");
      expect(response.body[1]).toEqual({
        id: "safe-model-id",
        label: "Safe model",
        name: "safe-model",
        description: "Safe description",
      });
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN;
      else process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN = previous;
    }
  });

  it("prevents discovered-model fragments from reconstructing across records", async () => {
    const token = "eyJmodels.records.signature_";
    mockListAdapterModels.mockResolvedValue([
      { id: token.slice(0, 1), label: "Prefix model" },
      { id: "continuation-model", label: token.slice(1) },
    ]);

    const response = await request(createApp())
      .get(`/api/companies/${companyId}/adapters/claude_local/models`);

    expect(response.status).toBe(200);
    expect(`${response.body[0].id}${response.body[1].label}`).not.toContain(token);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it.each([
    ["wakeup", `/api/agents/${agentId}/wakeup`],
    ["invoke", `/api/agents/${agentId}/heartbeat/invoke`],
  ] as const)("redacts credentials split across %s run response context fields", async (method, path) => {
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = resolvedSecret;
    const splitAt = 18;
    mockHeartbeatService[method].mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      contextSnapshot: {
        arbitraryLeft: resolvedSecret.slice(0, splitAt),
        arbitraryRight: resolvedSecret.slice(splitAt),
        benignContext: "preserved",
      },
    });

    try {
      const response = await request(createApp()).post(path).send({ reason: "manual" });
      const context = response.body.contextSnapshot;
      const reconstructed = `${context.arbitraryLeft}${context.arbitraryRight}`;

      expect(response.status).toBe(202);
      expect(response.body.status).toBe("queued");
      expect(context.benignContext).toBe("preserved");
      expect(reconstructed).not.toContain(resolvedSecret);
      expect(JSON.stringify(context)).toContain("***REDACTED***");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  });
});

describe("agent diagnostic status and session responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAdapterStatusService.resetExpiredStatuses.mockResolvedValue([]);
  });

  it.each(["collection", "detail"] as const)(
    "prevents %s adapter status fields from reconstructing a JWT",
    async (surface) => {
      const token = "eyJstatus.payload.signature_";
      const status = {
        adapterType: "claude_local",
        status: "offline",
        statusMessage: "eyJstatus.",
        lastError: "payload.",
        lastProbeMessage: "signature_",
      };
      mockAdapterStatusService.listAll.mockResolvedValue([status]);
      mockAdapterStatusService.getByType.mockResolvedValue(status);

      const response = await request(createApp()).get(
        surface === "collection" ? "/api/adapters/status" : "/api/adapters/claude_local/status",
      );
      const row = surface === "collection" ? response.body[0] : response.body;

      expect(response.status).toBe(200);
      expect(`${row.statusMessage}${row.lastError}${row.lastProbeMessage}`).not.toContain(token);
      expect(JSON.stringify(row)).toContain("***REDACTED***");
    },
  );

  it("strictly isolates persisted diagnostics across separate adapter-status reads", async () => {
    const token = "eyJstatus.separate.signature_";
    mockAdapterStatusService.getByType.mockImplementation(async (type: string) =>
      type === "claude_local"
        ? {
            adapterType: type,
            status: "offline",
            statusMessage: token.slice(0, 1),
            lastError: null,
            lastProbeMessage: null,
          }
        : {
            adapterType: type,
            status: "offline",
            statusMessage: null,
            lastError: token.slice(1),
            lastProbeMessage: null,
          },
    );

    const first = await request(createApp()).get("/api/adapters/claude_local/status");
    const second = await request(createApp()).get("/api/adapters/codex_local/status");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(`${first.body.statusMessage}${second.body.lastError}`).not.toContain(token);
    expect(first.body.status).toBe("offline");
    expect(first.body.adapterType).toBe("claude_local");
  });

  it("keeps workspace-operation selectors while closing cross-record diagnostics", async () => {
    const token = "eyJworkspace.operations.signature_";
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId,
      contextSnapshot: { executionWorkspaceId: "workspace-1" },
    });
    mockWorkspaceOperationService.listForRun.mockResolvedValue([
      {
        id: "operation-1",
        companyId,
        command: token.slice(0, 1),
        metadata: { padding: "x".repeat(1_100_000) },
      },
      {
        id: "operation-2",
        companyId,
        command: "safe command",
        metadata: { detail: token.slice(1) },
      },
    ]);

    const response = await request(createApp()).get(
      "/api/heartbeat-runs/run-1/workspace-operations",
    );

    expect(response.status).toBe(200);
    expect(response.body.map((operation: { id: string }) => operation.id)).toEqual([
      "operation-1",
      "operation-2",
    ]);
    expect(`${response.body[0].command}${response.body[1].metadata.detail}`).not.toContain(token);
    expect(response.body[0].metadata).toEqual({ padding: "***REDACTED***" });
  });

  it("bounds task sessions and sanitizes each complete session record", async () => {
    const token = "eyJsession.payload.signature_";
    mockHeartbeatService.listTaskSessions.mockResolvedValue([{
      id: "session-1",
      sessionDisplayId: "eyJsession.",
      sessionParamsJson: { detail: "payload.signature_" },
    }]);

    const response = await request(createApp()).get(
      `/api/agents/${agentId}/task-sessions?limit=9999`,
    );

    expect(response.status).toBe(200);
    expect(mockHeartbeatService.listTaskSessions).toHaveBeenCalledWith(agentId, 500);
    expect(
      `${response.body[0].sessionDisplayId}${response.body[0].sessionParamsJson.detail}`,
    ).not.toContain(token);
    expect(JSON.stringify(response.body[0])).toContain("***REDACTED***");
  });

  it.each(["read", "reset"] as const)(
    "sanitizes the complete runtime state on %s",
    async (surface) => {
      const token = "eyJruntime.payload.signature_";
      const state = {
        agentId,
        sessionId: "eyJruntime.",
        stateJson: { detail: "payload.signature_" },
      };
      mockHeartbeatService.getRuntimeState.mockResolvedValue(state);
      mockHeartbeatService.resetRuntimeSession.mockResolvedValue(state);

      const response = surface === "read"
        ? await request(createApp()).get(`/api/agents/${agentId}/runtime-state`)
        : await request(createApp())
            .post(`/api/agents/${agentId}/runtime-state/reset-session`)
            .send({});

      expect(response.status).toBe(200);
      expect(`${response.body.sessionId}${response.body.stateJson.detail}`).not.toContain(token);
      expect(JSON.stringify(response.body)).toContain("***REDACTED***");
    },
  );
});
