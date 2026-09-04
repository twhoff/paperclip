import express from "express";
import { homedir } from "node:os";
import request from "supertest";
import { heartbeatRuns } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import {
  heartbeatService,
  normalizeAgentTaskSessionListLimit,
} from "../services/heartbeat.js";

const mockHeartbeatService = vi.hoisted(() => ({
  list: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  listEvents: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockInstanceSettings = vi.hoisted(() => ({ censorUsernameInLogs: false }));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, collectSensitiveEnvValues: () => [] };
});

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  goalService: () => ({}),
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
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

vi.mock("../redaction.js", async () => {
  const actual = await vi.importActual<typeof import("../redaction.js")>("../redaction.js");
  return { ...actual, redactEventPayload: (value: unknown) => value };
});
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockImplementation(async () => ({ ...mockInstanceSettings })),
  }),
}));
vi.mock("../log-redaction.js", async () => {
  const actual = await vi.importActual<typeof import("../log-redaction.js")>(
    "../log-redaction.js",
  );
  return { ...actual, redactCurrentUserValue: (value: unknown) => value };
});

function createBoardApp(db: any = {}, companyIds = ["company-1"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds,
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

function createListDbStub(rows: Array<Record<string, unknown>>) {
  const query: Record<string, any> = {};
  query.from = vi.fn(() => query);
  query.innerJoin = vi.fn(() => query);
  query.where = vi.fn(() => query);
  query.orderBy = vi.fn(() => query);
  query.limit = vi.fn(async () => rows);
  query.then = (resolve: (value: Array<Record<string, unknown>>) => unknown) =>
    Promise.resolve(rows).then(resolve);

  const select = vi.fn(() => query);
  return { db: { select } as any, query, select };
}

function createEventPaginationDbStub(rows: Array<Record<string, unknown>>) {
  let pageCall = 0;
  const queries: Array<Record<string, any>> = [];
  const select = vi.fn(() => {
    const query: Record<string, any> = {};
    query.from = vi.fn(() => query);
    query.where = vi.fn(() => query);
    query.orderBy = vi.fn(() => query);
    query.limit = vi.fn(async (limit: number) => {
      if (limit === 1) {
        const row = rows[pageCall];
        pageCall += 1;
        return row ? [row] : [];
      }
      return rows.slice(0, limit);
    });
    query.then = (resolve: (value: Array<Record<string, unknown>>) => unknown) =>
      Promise.resolve(rows).then(resolve);
    queries.push(query);
    return query;
  });

  return { db: { select } as any, queries, select };
}

describe("heartbeat run list bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.list.mockResolvedValue([]);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue(null);
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockInstanceSettings.censorUsernameInLogs = false;
  });

  it("normalizes task-session limits to a bounded range", () => {
    expect(normalizeAgentTaskSessionListLimit(undefined)).toBe(100);
    expect(normalizeAgentTaskSessionListLimit(Number.NaN)).toBe(100);
    expect(normalizeAgentTaskSessionListLimit(0)).toBe(1);
    expect(normalizeAgentTaskSessionListLimit(9999)).toBe(500);
  });

  it("applies the default page bound when the route omits limit", async () => {
    const response = await request(createBoardApp()).get("/api/companies/company-1/heartbeat-runs");

    expect(response.status).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith("company-1", undefined, 200);
  });

  it("prevents list clients from rebuilding a JWT across summary and error", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    mockHeartbeatService.list.mockResolvedValue([
      {
        id: "run-1",
        companyId: "company-1",
        error: token.slice(0, splitAt),
        resultJson: { summary: token.slice(splitAt) },
      },
    ]);

    const response = await request(createBoardApp()).get(
      "/api/companies/company-1/heartbeat-runs",
    );

    expect(response.status).toBe(200);
    expect(`${response.body[0].error}${response.body[0].resultJson.summary}`).not.toContain(token);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("prevents detail clients from rebuilding a JWT across result streams", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const splitAt = 2;
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      resultJson: {
        stdout: token.slice(0, splitAt),
        stderr: token.slice(splitAt),
      },
    });

    const response = await request(createBoardApp()).get("/api/heartbeat-runs/run-1");

    expect(response.status).toBe(200);
    expect(`${response.body.resultJson.stdout}${response.body.resultJson.stderr}`).not.toContain(token);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("prevents cancel clients from rebuilding a JWT across stored excerpts", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("signature");
    const run = {
      id: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      stdoutExcerpt: token.slice(0, splitAt),
      stderrExcerpt: token.slice(splitAt),
    };
    mockHeartbeatService.getRun.mockResolvedValue(run);
    mockHeartbeatService.cancelRun.mockResolvedValue(run);

    const response = await request(createBoardApp()).post("/api/heartbeat-runs/run-1/cancel");

    expect(response.status).toBe(200);
    expect(`${response.body.stdoutExcerpt}${response.body.stderrExcerpt}`).not.toContain(token);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("honors current-user censorship consistently across run list surfaces", async () => {
    mockInstanceSettings.censorUsernameInLogs = true;
    const privatePath = `${homedir()}/private-agent-run`;
    const run = {
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      error: privatePath,
      triggerDetail: privatePath,
    };
    mockHeartbeatService.list.mockResolvedValue([run]);
    mockHeartbeatService.getRun.mockResolvedValue(run);
    mockHeartbeatService.cancelRun.mockResolvedValue(run);
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
    });
    const { db } = createListDbStub([run]);

    const responses = await Promise.all([
      request(createBoardApp()).get("/api/companies/company-1/heartbeat-runs"),
      request(createBoardApp()).post("/api/heartbeat-runs/run-1/cancel"),
      request(createBoardApp(db)).get("/api/companies/company-1/live-runs"),
      request(createBoardApp(db)).get("/api/issues/PAP-475/live-runs"),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(homedir());
    }
  });

  it("rejects a cross-company heartbeat cancellation before mutation", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-foreign",
      companyId: "company-2",
      agentId: "agent-2",
    });

    const response = await request(createBoardApp()).post(
      "/api/heartbeat-runs/run-foreign/cancel",
    );

    expect(response.status).toBe(403);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("bounds cyclic heartbeat event payloads at the response boundary", async () => {
    const payload: Record<string, unknown> = { message: "safe" };
    payload.self = payload;
    mockHeartbeatService.getRun.mockResolvedValue({ id: "run-1", companyId: "company-1" });
    mockHeartbeatService.listEvents.mockResolvedValue([
      { id: "event-1", runId: "run-1", seq: 1, eventType: "status", payload },
    ]);

    const response = await request(createBoardApp()).get("/api/heartbeat-runs/run-1/events");

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("strictly isolates diagnostic event fragments across separate response pages", async () => {
    const token = "eyJevents.separate.signature_";
    mockHeartbeatService.getRun.mockResolvedValue({ id: "run-1", companyId: "company-1" });
    mockHeartbeatService.listEvents
      .mockResolvedValueOnce([
        { id: "event-1", runId: "run-1", seq: 1, eventType: "log", payload: { detail: token.slice(0, 1) } },
      ])
      .mockResolvedValueOnce([
        { id: "event-2", runId: "run-1", seq: 2, eventType: "log", payload: { detail: token.slice(1) } },
      ]);

    const first = await request(createBoardApp()).get("/api/heartbeat-runs/run-1/events?limit=1");
    const second = await request(createBoardApp()).get("/api/heartbeat-runs/run-1/events?afterSeq=1&limit=1");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body[0].id).toBe("event-1");
    expect(second.body[0].id).toBe("event-2");
    expect(`${first.body[0].payload.detail}${second.body[0].payload.detail}`).not.toContain(token);
    expect(JSON.stringify(first.body)).toContain("***REDACTED***");
  });

  it.each(["company", "issue"] as const)(
    "sanitizes every %s live-run response record",
    async (surface) => {
      const token = "eyJlive.payload.signature_";
      const { db } = createListDbStub([{
        id: "run-live",
        companyId: "company-1",
        triggerDetail: "eyJlive.",
        agentName: "payload.signature_",
        status: "running",
      }]);
      mockIssueService.getByIdentifier.mockResolvedValue({
        id: "issue-1",
        companyId: "company-1",
      });

      const response = await request(createBoardApp(db)).get(
        surface === "company"
          ? "/api/companies/company-1/live-runs"
          : "/api/issues/PAP-475/live-runs",
      );
      const row = response.body[0];

      expect(response.status).toBe(200);
      expect(`${row.triggerDetail}${row.agentName}`).not.toContain(token);
      expect(JSON.stringify(row)).toContain("***REDACTED***");
    },
  );

  it("prevents active-run clients from rebuilding a JWT across result streams", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-1",
      assigneeAgentId: "agent-1",
      status: "in_progress",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      status: "running",
      resultJson: {
        stdout: token.slice(0, splitAt),
        stderr: token.slice(splitAt),
      },
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      name: "Agent One",
      adapterType: "claude_local",
    });

    const response = await request(createBoardApp()).get("/api/issues/PAP-475/active-run");

    expect(response.status).toBe(200);
    expect(`${response.body.resultJson.stdout}${response.body.resultJson.stderr}`).not.toContain(token);
    expect(response.body.resultJson).toEqual({
      stdout: "***REDACTED***",
      stderr: "payload.signature_with-hyphen_",
    });
    expect(response.body.agentName).toBe("Agent One");
  });

  it("sanitizes the composed active-run response including agent fields", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-1",
      assigneeAgentId: "agent-1",
      status: "in_progress",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      status: "running",
      resultJson: { stdout: token.slice(0, 1) },
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      name: token.slice(1),
      adapterType: "claude_local",
    });

    const response = await request(createBoardApp()).get("/api/issues/PAP-475/active-run");

    expect(response.status).toBe(200);
    expect(`${response.body.resultJson.stdout}${response.body.agentName}`).not.toContain(token);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
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

  it("removes a JWT fragment that crosses the bounded SQL summary edge", async () => {
    const boundedPrefix = `${"a".repeat(498)}:eyJhbGciOi`;
    const { db } = createListDbStub([
      { id: "run-1", resultJson: { summary: boundedPrefix } },
    ]);

    const rows = await heartbeatService(db).list("company-1");
    const summary = (rows[0]?.resultJson as { summary?: string } | null)?.summary;

    expect(summary).not.toContain("eyJ");
    expect(summary).toContain("*");
  });

  it("normalizes a non-finite event limit before the database query", async () => {
    const { db, queries } = createEventPaginationDbStub([]);

    await heartbeatService(db).listEvents("run-1", 0, Number.NaN);

    expect(queries[0]?.limit).toHaveBeenCalledWith(200);
  });

  it.each([1, 2, 48])(
    "redacts a JWT split at offset %i before applying afterSeq pagination",
    async (splitAt) => {
      const token =
        "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi0xIn0.hostile_signature-ending-in-hyphen-";
      const rows = [
        {
          id: "event-1",
          runId: "run-1",
          seq: 1,
          eventType: "log",
          stream: "stdout",
          message: null,
          payload: { chunk: token.slice(0, splitAt), label: "first" },
        },
        {
          id: "event-2",
          runId: "run-1",
          seq: 2,
          eventType: "log",
          stream: "stdout",
          message: null,
          payload: { chunk: token.slice(splitAt), label: "second" },
        },
      ];
      const { db } = createEventPaginationDbStub(rows);
      const heartbeat = heartbeatService(db);

      const firstPage = await heartbeat.listEvents("run-1", 0, 1);
      const secondPage = await heartbeat.listEvents("run-1", 1, 1);
      const pages = [...firstPage, ...secondPage];
      const recombined = pages
        .map((event) => (event.payload as { chunk: string }).chunk)
        .join("");

      expect(firstPage.map((event) => event.seq)).toEqual([1]);
      expect(secondPage.map((event) => event.seq)).toEqual([2]);
      expect(recombined).not.toContain(token);
      expect(JSON.stringify(pages)).toContain("***REDACTED***");
      expect(pages.map((event) => (event.payload as { label: string }).label)).toEqual([
        "first",
        "second",
      ]);
    },
  );

  it("redacts a generic JWT split across sibling fields in a historical event", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const rows = [{
      id: "event-1",
      runId: "run-1",
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      message: "adapter invocation",
      payload: {
        command: "eyJheader.",
        metadata: { fragment: "payload.signature_with-hyphen_" },
      },
    }];
    const { db } = createEventPaginationDbStub(rows);

    const events = await heartbeatService(db).listEvents("run-1", 0, 200);
    const payload = events[0]?.payload as {
      command: string;
      metadata: { fragment: string };
    };

    expect(`${payload.command}${payload.metadata.fragment}`).not.toContain(token);
    expect(payload.command).toBe("***REDACTED***");
    expect(payload.metadata.fragment).toBe("payload.signature_with-hyphen_");
  });
});
