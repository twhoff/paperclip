import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getAncestors: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
  listActiveCompanyGoals: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  goalService: () => mockGoalService,
  projectService: () => mockProjectService,
  agentService: () => ({}),
  heartbeatService: () => ({}),
  documentService: () => ({}),
  routineService: () => ({}),
  accessService: () => ({}),
  issueApprovalService: () => ({}),
  executionWorkspaceService: () => ({}),
  workProductService: () => ({}),
  logActivity: vi.fn(),
}));

const baseIssue = {
  id: "issue-1",
  identifier: "TEST-1",
  companyId: "company-1",
  title: "Test issue",
  description: "Issue body",
  status: "in_progress",
  priority: "medium",
  projectId: null,
  goalId: "goal-1",
  parentId: null,
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  updatedAt: new Date("2026-01-01").toISOString(),
};

const baseGoal = {
  id: "goal-1",
  title: "Automate groceries",
  description: "Full description of the company goal",
  status: "active",
  level: "company",
  parentId: null,
  ownerAgentId: "agent-owner",
};

function createApp() {
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
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /issues/:id/heartbeat-context — goals changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getCommentCursor.mockResolvedValue({ totalComments: 0, latestCommentId: null, latestCommentAt: null });
    mockIssueService.getComment.mockResolvedValue(null);
    mockGoalService.getById.mockResolvedValue(baseGoal);
    mockGoalService.listActiveCompanyGoals.mockResolvedValue([baseGoal]);
    mockProjectService.getById.mockResolvedValue(null);
  });

  it("includes goal.description in response (regression guard for un-strip)", async () => {
    const res = await request(createApp()).get("/api/issues/issue-1/heartbeat-context");
    expect(res.status).toBe(200);
    expect(res.body.goal).toBeDefined();
    expect(res.body.goal.description).toBe("Full description of the company goal");
  });

  it("includes goal.ownerAgentId in response", async () => {
    const res = await request(createApp()).get("/api/issues/issue-1/heartbeat-context");
    expect(res.status).toBe(200);
    expect(res.body.goal.ownerAgentId).toBe("agent-owner");
  });

  it("includes companyGoals array populated from listActiveCompanyGoals", async () => {
    const res = await request(createApp()).get("/api/issues/issue-1/heartbeat-context");
    expect(res.status).toBe(200);
    expect(res.body.companyGoals).toHaveLength(1);
    expect(res.body.companyGoals[0].id).toBe("goal-1");
    expect(res.body.companyGoals[0].title).toBe("Automate groceries");
    expect(res.body.companyGoals[0].description).toBe("Full description of the company goal");
  });

  it("returns empty companyGoals when no active company goals exist", async () => {
    mockGoalService.listActiveCompanyGoals.mockResolvedValue([]);
    const res = await request(createApp()).get("/api/issues/issue-1/heartbeat-context");
    expect(res.status).toBe(200);
    expect(res.body.companyGoals).toEqual([]);
  });

  it("uses listActiveCompanyGoals (filters active-only at DB level)", async () => {
    await request(createApp()).get("/api/issues/issue-1/heartbeat-context");
    expect(mockGoalService.listActiveCompanyGoals).toHaveBeenCalledWith("company-1");
  });

  it("returns 404 for unknown issue", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(createApp()).get("/api/issues/missing/heartbeat-context");
    expect(res.status).toBe(404);
  });
});
