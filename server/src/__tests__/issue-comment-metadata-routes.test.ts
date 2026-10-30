import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

const VIA = {
  source: "holly",
  sessionId: "agent-9FC4895E-8746-4320-8B54-BD3DAFA48C3B",
  name: "Kryten",
  role: "qa-lead",
} as const;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-900",
    title: "Comment attribution",
  };
}

describe("issue comment metadata routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockImplementation(
      async (_id: string, body: string, _actor: unknown, metadata?: Record<string, unknown> | null) => ({
        id: "comment-1",
        issueId: ISSUE_ID,
        companyId: "company-1",
        body,
        metadata: metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: null,
        authorUserId: "local-board",
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("stores the via label on a posted comment and records it in the activity", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "PASS", metadata: { via: VIA } });

    expect(res.status).toBe(201);
    expect(res.body.metadata).toEqual({ via: VIA });
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "PASS",
      expect.anything(),
      { via: VIA },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({ via: VIA }),
      }),
    );
  });

  it("keeps a comment without metadata unlabelled", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "plain" });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(ISSUE_ID, "plain", expect.anything(), null);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.not.objectContaining({ via: expect.anything() }),
      }),
    );
  });

  it.each([
    ["an unknown metadata key", { other: true }],
    ["an unknown via key", { via: { ...VIA, extra: "x" } }],
    ["a via source other than holly", { via: { ...VIA, source: "someone" } }],
    ["a via without a session id", { via: { source: "holly", name: "Kryten" } }],
    ["an oversized session id", { via: { ...VIA, sessionId: "a".repeat(129) } }],
  ])("rejects %s", async (_label, metadata) => {
    const res = await request(createApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "PASS", metadata });

    expect(res.status).toBe(400);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("labels the comment written by an issue update", async () => {
    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_progress", comment: "starting", commentMetadata: { via: VIA } });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, { status: "in_progress" });
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "starting",
      expect.anything(),
      { via: VIA },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({ via: VIA }),
      }),
    );
  });
});
