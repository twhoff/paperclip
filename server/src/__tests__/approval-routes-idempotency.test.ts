import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

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
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval payloads beyond the bounded nesting limit", async () => {
    let payload: Record<string, unknown> = { safe: "value" };
    for (let depth = 0; depth < 33; depth += 1) payload = { nested: payload };

    const res = await request(createApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "approve_ceo_strategy", payload });

    expect(res.status).toBe(400);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("redacts credentials split across an approval response payload", async () => {
    const token = "eyJapproval.payload.signature_";
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "approve_ceo_strategy",
      status: "pending",
      payload: {
        left: token.slice(0, 1),
        right: token.slice(1),
      },
    });

    const res = await request(createApp()).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).toContain("***REDACTED***");
  });

  it("redacts requester wakeup failures before activity persistence", async () => {
    const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const secret = "approval-wakeup-current-secret";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "name", { enumerable: true, value: secret.slice(0, 12) });
    Object.defineProperty(hostile, "message", { enumerable: true, value: secret.slice(12) });
    Object.defineProperty(hostile, "stack", {
      enumerable: true,
      get() {
        throw new Error("hostile stack getter");
      },
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: true,
    });
    mockHeartbeatService.wakeup.mockRejectedValue(hostile);

    try {
      const res = await request(createApp())
        .post("/api/approvals/approval-1/approve")
        .send({});
      expect(res.status).toBe(200);
      const serializedCalls = JSON.stringify(mockLogActivity.mock.calls);
      expect(serializedCalls).not.toContain(secret);
      expect(serializedCalls).toContain("***REDACTED***");
    } finally {
      if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    }
  });
});
