import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  goalService: () => ({}),
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({ resolveAdapterConfigForRuntime: vi.fn(), normalizeAdapterConfigForPersistence: vi.fn() }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
  workspaceOperationService: () => ({}),
  adapterStatusService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

function createAgentApp(agentId = "35a79d4c-c188-4bfd-b1d7-304ee7479df3", companyId = "company-1") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId,
      companyIds: [companyId],
      source: "jwt",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildAgentRow(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId: "company-1",
    name: "Test Agent",
    role: "engineer" as const,
    status: "idle" as const,
    adapterType: "claude_local",
    adapterConfig: { instructionsRootPath: "/tmp/instructions" },
    runtimeConfig: {},
    permissions: { canCreateAgents: false },
    spentMonthlyCents: 0,
    budgetMonthlyCents: 0,
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
    urlKey: "test-agent",
    ...overrides,
  };
}

describe("GET /agents/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
  });

  it("returns workspacePath derived from the agent's UUID", async () => {
    const agentId = "35a79d4c-c188-4bfd-b1d7-304ee7479df3";
    const storedSecret = "stored-plain-agent-secret";
    mockAgentService.getById.mockResolvedValue(
      buildAgentRow(agentId, {
        adapterConfig: {
          instructionsRootPath: "/tmp/instructions",
          apiKey: storedSecret,
        },
      }),
    );

    const res = await request(createAgentApp(agentId)).get("/api/agents/me");
    expect(res.status).toBe(200);
    expect(res.body.workspacePath).toBe(resolveDefaultAgentWorkspaceDir(agentId));
    expect(res.body.workspacePath).toMatch(/\/workspaces\/35a79d4c-c188-4bfd-b1d7-304ee7479df3$/);
    expect(res.body.adapterConfig.apiKey).toBe("***REDACTED***");
    expect(JSON.stringify(res.body)).not.toContain(storedSecret);
  });

  it("workspacePath is identical for managed vs external instructions bundles", async () => {
    // Whether AGENTS.md is managed by Paperclip or pointed at an external file,
    // the agent's persistent memory still lives at the same workspaces/<id> path.
    const agentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    mockAgentService.getById.mockResolvedValueOnce(
      buildAgentRow(agentId, { adapterConfig: { instructionsBundleMode: "managed" } }),
    );
    const resManaged = await request(createAgentApp(agentId)).get("/api/agents/me");

    mockAgentService.getById.mockResolvedValueOnce(
      buildAgentRow(agentId, {
        adapterConfig: {
          instructionsBundleMode: "external",
          instructionsRootPath: "/some/external/path",
        },
      }),
    );
    const resExternal = await request(createAgentApp(agentId)).get("/api/agents/me");

    expect(resManaged.body.workspacePath).toBe(resolveDefaultAgentWorkspaceDir(agentId));
    expect(resExternal.body.workspacePath).toBe(resolveDefaultAgentWorkspaceDir(agentId));
    expect(resManaged.body.workspacePath).toBe(resExternal.body.workspacePath);
  });

  it("workspacePath is absolute and instance-aware (under PAPERCLIP_HOME/instances/<id>/workspaces/)", async () => {
    const agentId = "11111111-2222-3333-4444-555555555555";
    mockAgentService.getById.mockResolvedValue(buildAgentRow(agentId));

    const res = await request(createAgentApp(agentId)).get("/api/agents/me");
    expect(res.body.workspacePath).toMatch(/^\/.+\/instances\/[^/]+\/workspaces\/[0-9a-f-]+$/);
  });

  it("workspacePath is null when the agent id contains illegal path characters", async () => {
    // Defensive: resolveDefaultAgentWorkspaceDir throws on non-PATH_SEGMENT ids.
    // buildAgentDetail catches and returns null rather than failing the response.
    const agentId = "../escape/attempt";
    mockAgentService.getById.mockResolvedValue(buildAgentRow(agentId));

    const res = await request(createAgentApp(agentId)).get("/api/agents/me");
    expect(res.status).toBe(200);
    expect(res.body.workspacePath).toBeNull();
  });

  it("returns 401 for non-agent actors (board session)", async () => {
    const res = await request(createBoardApp()).get("/api/agents/me");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the actor's agentId is not found", async () => {
    mockAgentService.getById.mockResolvedValue(null);
    const res = await request(createAgentApp("ghost-agent-id")).get("/api/agents/me");
    expect(res.status).toBe(404);
  });
});
