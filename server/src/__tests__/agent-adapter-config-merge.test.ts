import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
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

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
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
  heartbeatService: () => ({
    listTaskSessions: vi.fn(),
    resetRuntimeSession: vi.fn(),
  }),
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({ list: vi.fn() }),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
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
  app.use(errorHandler);
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
});
