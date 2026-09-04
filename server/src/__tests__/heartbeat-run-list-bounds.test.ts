import express from "express";
import request from "supertest";
import { heartbeatRuns } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";

const mockHeartbeatService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => ({}),
  goalService: () => ({}),
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(),
    normalizeAdapterConfigForPersistence: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
  workspaceOperationService: () => ({}),
  adapterStatusService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

vi.mock("../redaction.js", () => ({ redactEventPayload: (value: unknown) => value }));
vi.mock("../log-redaction.js", () => ({ redactCurrentUserValue: (value: unknown) => value }));

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

function createListDbStub(rows: Array<Record<string, unknown>>) {
  const query: Record<string, any> = {};
  query.from = vi.fn(() => query);
  query.where = vi.fn(() => query);
  query.orderBy = vi.fn(() => query);
  query.limit = vi.fn(async () => rows);
  query.then = (resolve: (value: Array<Record<string, unknown>>) => unknown) =>
    Promise.resolve(rows).then(resolve);

  const select = vi.fn(() => query);
  return { db: { select } as any, query, select };
}

describe("heartbeat run list bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.list.mockResolvedValue([]);
  });

  it("applies the default page bound when the route omits limit", async () => {
    const response = await request(createBoardApp()).get("/api/companies/company-1/heartbeat-runs");

    expect(response.status).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith("company-1", undefined, 200);
  });

  it("enforces the page bound inside the service and does not select full result_json", async () => {
    const { db, query, select } = createListDbStub([
      { id: "run-1", resultJson: { summary: "bounded" } },
    ]);

    const rows = await heartbeatService(db).list("company-1");

    expect(query.limit).toHaveBeenCalledWith(200);
    const selection = select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(selection.resultJson).not.toBe(heartbeatRuns.resultJson);
    expect(rows[0]?.resultJson).toEqual({ summary: "bounded" });
  });
});
