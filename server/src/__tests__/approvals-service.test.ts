import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());
const mockInstanceSettings = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => mockInstanceSettings),
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("sanitizes approval payloads and decision notes before database insertion", async () => {
    const insertedValues = vi.fn();
    const returned = {
      id: "approval-1",
      companyId: "company-1",
      type: "approve_ceo_strategy",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    };
    const db = {
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          insertedValues(value);
          return { returning: vi.fn(async () => [returned]) };
        },
      })),
    };
    const secret = "approval-database-secret-value";
    const token = "eyJapproval.payload.signature_";

    await approvalService(db as any).create("company-1", {
      type: "approve_ceo_strategy",
      status: "pending",
      payload: { apiKey: secret, echoed: secret },
      decisionNote: `${token} ordinary e`,
    } as any);

    const persisted = JSON.stringify(insertedValues.mock.calls[0]?.[0]);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain("ordinary e");
    expect(persisted).toContain("***REDACTED***");
  });

  it("strictly sanitizes split credentials before approval-comment insertion", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const existing = createApproval("pending");
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [existing]),
        })),
      })),
      insert: vi.fn(() => ({
        values: (value: Record<string, unknown>) => {
          inserted.push(value);
          return {
            returning: vi.fn(async () => [{ id: `comment-${inserted.length}`, ...value }]),
          };
        },
      })),
    };
    const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const secret = "approval-comment-current-secret";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;
    const svc = approvalService(db as any);

    try {
      await svc.addComment("approval-1", "e", { userId: "user-1" });
      await svc.addComment("approval-1", "yJcomment.payload.signature_", { userId: "user-1" });
      await svc.addComment("approval-1", secret.slice(0, 12), { userId: "user-1" });
      await svc.addComment("approval-1", secret.slice(12), { userId: "user-1" });
    } finally {
      if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    }

    const persisted = inserted.map((row) => String(row.body)).join("");
    expect(persisted).not.toContain("eyJcomment.payload.signature_");
    expect(persisted).not.toContain(secret);
    expect(String(inserted[0]?.body)).toBe("***REDACTED***");
    expect(String(inserted[2]?.body)).toBe("***REDACTED***");
  });
});
