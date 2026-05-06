import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const mockGoalService = vi.hoisted(() => ({
  listScopedForAgent: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  goalService: () => mockGoalService,
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
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

vi.mock("../redaction.js", () => ({ redactEventPayload: (x: unknown) => x }));
vi.mock("../log-redaction.js", () => ({ redactCurrentUserValue: (x: unknown) => x }));

const scopedGoalsResponse = {
  company: [{ id: "cg-1", title: "Automate groceries", description: "desc", status: "active", level: "company", parentId: null }],
  team: [{ id: "tg-1", title: "Improve shopping accuracy", description: null, status: "active", level: "team", parentId: null }],
  agent: [{ id: "ag-1", title: "Ship recipe importer", description: null, status: "planned", level: "agent", parentId: null }],
};

function createAgentApp(agentId = "agent-1", companyId = "company-1") {
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

describe("GET /agents/me/scoped-goals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoalService.listScopedForAgent.mockResolvedValue(scopedGoalsResponse);
  });

  it("returns company, team, and agent buckets for authenticated agent", async () => {
    const res = await request(createAgentApp()).get("/api/agents/me/scoped-goals");
    expect(res.status).toBe(200);
    expect(res.body.company).toHaveLength(1);
    expect(res.body.team).toHaveLength(1);
    expect(res.body.agent).toHaveLength(1);
    expect(res.body.company[0].id).toBe("cg-1");
    expect(res.body.team[0].id).toBe("tg-1");
    expect(res.body.agent[0].id).toBe("ag-1");
  });

  it("calls listScopedForAgent with the authenticated agent's ID", async () => {
    await request(createAgentApp("my-agent-id")).get("/api/agents/me/scoped-goals");
    expect(mockGoalService.listScopedForAgent).toHaveBeenCalledWith("my-agent-id");
  });

  it("returns 401 for non-agent actors (board session)", async () => {
    const res = await request(createBoardApp()).get("/api/agents/me/scoped-goals");
    expect(res.status).toBe(401);
  });

  it("agent without reports_to sees NULL-owner team goals + own agent goals", async () => {
    mockGoalService.listScopedForAgent.mockResolvedValue({
      company: [],
      team: [{ id: "null-owner-team", title: "Public team goal", description: null, status: "active", level: "team", parentId: null }],
      agent: [{ id: "my-agent-goal", title: "Personal goal", description: null, status: "active", level: "agent", parentId: null }],
    });
    const res = await request(createAgentApp("isolated-agent")).get("/api/agents/me/scoped-goals");
    expect(res.status).toBe(200);
    expect(res.body.team).toHaveLength(1);
    expect(res.body.team[0].id).toBe("null-owner-team");
    expect(res.body.agent).toHaveLength(1);
    expect(res.body.agent[0].id).toBe("my-agent-goal");
  });

  it("cross-company isolation: different agent IDs produce different results", async () => {
    mockGoalService.listScopedForAgent
      .mockResolvedValueOnce({ company: [{ id: "company-a-goal" }], team: [], agent: [] })
      .mockResolvedValueOnce({ company: [{ id: "company-b-goal" }], team: [], agent: [] });

    const resA = await request(createAgentApp("agent-a", "company-a")).get("/api/agents/me/scoped-goals");
    const resB = await request(createAgentApp("agent-b", "company-b")).get("/api/agents/me/scoped-goals");

    expect(resA.body.company[0].id).toBe("company-a-goal");
    expect(resB.body.company[0].id).toBe("company-b-goal");
    expect(mockGoalService.listScopedForAgent).toHaveBeenNthCalledWith(1, "agent-a");
    expect(mockGoalService.listScopedForAgent).toHaveBeenNthCalledWith(2, "agent-b");
  });
});
