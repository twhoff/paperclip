import express from "express";
import { homedir } from "node:os";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));
const mockInstanceSettings = vi.hoisted(() => ({ censorUsernameInLogs: false }));

vi.mock("../services/activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/activity.js")>()),
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockImplementation(async () => ({ ...mockInstanceSettings })),
  }),
}));

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

function createApp(actor: Record<string, unknown> = boardActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("activity routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettings.censorUsernameInLogs = false;
  });

  it("honors current-user censorship for activity reads and writes", async () => {
    mockInstanceSettings.censorUsernameInLogs = true;
    const privatePath = `${homedir()}/private-activity`;
    const event = {
      id: "activity-1",
      companyId: "company-1",
      actorType: "system",
      actorId: "system-1",
      action: "activity.created",
      entityType: "test",
      entityId: "test-1",
      details: { path: privatePath },
    };
    mockActivityService.list.mockResolvedValue([event]);
    mockActivityService.create.mockImplementationOnce(async (input) => ({
      id: "activity-2",
      ...input,
    }));

    const [listed, created] = await Promise.all([
      request(createApp()).get("/api/companies/company-1/activity"),
      request(createApp()).post("/api/companies/company-1/activity").send(event),
    ]);

    expect(listed.status).toBe(200);
    expect(created.status).toBe(201);
    expect(JSON.stringify(listed.body)).not.toContain(homedir());
    expect(JSON.stringify(created.body)).not.toContain(homedir());
    expect(JSON.stringify(mockActivityService.create.mock.calls[0]?.[0])).not.toContain(homedir());
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
      },
    ]);

    const res = await request(createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1" }]);
  });

  it("redacts historical run tokens returned through issue activity", async () => {
    const token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJydW5JZCI6InJ1bi0xIn0.activity_signature";
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        resultJson: { stdout: `PAPERCLIP_API_KEY=${token}` },
      },
    ]);

    const res = await request(createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(res.body[0].resultJson.stdout).toBe("PAPERCLIP_API_KEY=***REDACTED***");
  });

  it("prevents issue-run clients from rebuilding a split historical JWT", async () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        resultJson: {
          stdout: token.slice(0, splitAt),
          stderr: token.slice(splitAt),
        },
      },
    ]);

    const res = await request(createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(`${res.body[0].resultJson.stdout}${res.body[0].resultJson.stderr}`).not.toContain(token);
    expect(JSON.stringify(res.body)).toContain("***REDACTED***");
  });

  it("fails closed for oversized issue-run diagnostics", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        resultJson: { stdout: "x".repeat(1_100_000), stderr: "safe" },
      },
    ]);

    const res = await request(createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(res.body[0].runId).toBe("run-1");
    expect(res.body[0].resultJson).toEqual({
      stdout: "***REDACTED***",
      stderr: "***REDACTED***",
    });
  });

  it.each([
    ["company activity", "/api/companies/company-1/activity", "list"],
    ["issue activity", "/api/issues/PAP-475/activity", "forIssue"],
  ] as const)("prevents clients from rebuilding split credentials in %s", async (_label, url, method) => {
    const token = "eyJactivity.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    const event = {
      id: "activity-1",
      details: {
        error: token.slice(0, splitAt),
        detail: token.slice(splitAt),
        source: "hire_hook",
      },
    };
    mockActivityService[method].mockResolvedValue([event]);
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });

    const response = await request(createApp()).get(url);

    expect(response.status).toBe(200);
    const details = response.body[0].details;
    expect(`${details.error}${details.detail}`).not.toContain(token);
    expect(JSON.stringify(details)).toContain("***REDACTED***");
    expect(details.source).toBe("hire_hook");
  });

  it.each([
    ["company activity", "/api/companies/company-1/activity", "list"],
    ["issue activity", "/api/issues/PAP-475/activity", "forIssue"],
  ] as const)("sanitizes split credentials across historical %s scalar fields", async (_label, url, method) => {
    const token = "eyJactivity.payload.signature_with-hyphen_";
    const event = {
      id: "activity-legacy-1",
      actorId: "system",
      action: token.slice(0, 1),
      entityType: "activity",
      entityId: token.slice(1),
      details: { source: "legacy_row" },
    };
    mockActivityService[method].mockResolvedValue([event]);
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });

    const response = await request(createApp()).get(url);

    expect(response.status).toBe(200);
    const returned = response.body[0];
    expect(`${returned.action}${returned.entityId}`).not.toContain(token);
    expect(JSON.stringify(returned)).toContain("***REDACTED***");
    expect(returned.details.source).toBe("legacy_row");
  });

  it.each([
    [
      "company activity pages",
      "/api/companies/company-1/activity?limit=2&page=1",
      "/api/companies/company-1/activity?limit=2&page=2",
      "list",
    ],
    [
      "separate issue activity reads",
      "/api/issues/PAP-475/activity",
      "/api/issues/PAP-475/activity",
      "forIssue",
    ],
  ] as const)("prevents reconstruction across %s", async (_label, firstUrl, secondUrl, method) => {
    const token = "eyJactivity.payload.signature_with-hyphen_";
    const prefix = {
      id: "activity-prefix",
      actorId: "system",
      action: token.slice(0, 1),
      entityType: "activity",
      entityId: "prefix",
      details: { source: "legacy_prefix" },
    };
    const ordinary = {
      id: "activity-ordinary",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: "ordinary",
      details: { source: "ordinary" },
    };
    const continuation = {
      id: "activity-continuation",
      actorId: "system",
      action: "issue.updated",
      entityType: "activity",
      entityId: token.slice(1),
      details: { source: "legacy_continuation" },
    };
    mockActivityService[method]
      .mockResolvedValueOnce([prefix, ordinary])
      .mockResolvedValueOnce([continuation]);
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });

    const first = await request(createApp()).get(firstUrl);
    const second = await request(createApp()).get(secondUrl);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(`${first.body[0].action}${second.body[0].entityId}`).not.toContain(token);
    expect(JSON.stringify(first.body)).toContain("***REDACTED***");
    expect(first.body[1].details.source).toBe("ordinary");
    expect(second.body[0].details.source).toBe("legacy_continuation");
  });

  it("sanitizes split details before direct activity persistence and response", async () => {
    const token = "eyJactivity.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    mockActivityService.create.mockImplementationOnce(async (input) => ({
      id: "activity-1",
      ...input,
    }));

    const response = await request(createApp())
      .post("/api/companies/company-1/activity")
      .send({
        actorType: "system",
        actorId: "system-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-1",
        details: {
          tail: token.slice(splitAt),
          prefix: token.slice(0, splitAt),
          source: "ordinary-metadata!",
        },
      });

    expect(response.status).toBe(201);
    const persistedDetails = mockActivityService.create.mock.calls[0]?.[0].details;
    for (const details of [persistedDetails, response.body.details]) {
      expect(`${details.prefix}${details.tail}`).not.toContain(token);
      expect(details.prefix).toBe("***REDACTED***");
      expect(details.source).toBe("ordinary-metadata!");
    }
  });

  it("sanitizes scalar fields as one record before direct persistence and response", async () => {
    const token = "direct-activity-secret-value-42";
    const splitAt = 15;
    const previous = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = token;
    mockActivityService.create.mockImplementationOnce(async (input) => ({
      id: "activity-1",
      ...input,
    }));

    try {
      const response = await request(createApp())
        .post("/api/companies/company-1/activity")
        .send({
          actorType: "system",
          actorId: token.slice(splitAt),
          action: token.slice(0, splitAt),
          entityType: `plugin-${token}`,
          entityId: "plugin-1",
          details: { source: "direct_post", benign: "ordinary-metadata!" },
        });

      expect(response.status).toBe(201);
      const persisted = mockActivityService.create.mock.calls[0]?.[0];
      for (const record of [persisted, response.body]) {
        expect(`${record.action}${record.actorId}`).not.toContain(token);
        expect(JSON.stringify(record)).not.toContain(token);
        expect(JSON.stringify(record)).toContain("***REDACTED***");
        expect(record.details.benign).toBe("ordinary-metadata!");
      }
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previous;
    }
  });

  it("caps an explicit issue activity limit before querying the service", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.forIssue.mockResolvedValue([]);

    const response = await request(createApp()).get(
      "/api/issues/PAP-475/activity?limit=50000",
    );

    expect(response.status).toBe(200);
    expect(mockActivityService.forIssue).toHaveBeenCalledWith("issue-uuid-1", 500);
  });

  it.each([
    ["an unauthenticated caller", { type: "none" }, 401],
    [
      "a board user from another company",
      { ...boardActor, companyIds: ["company-2"] },
      403,
    ],
  ])("rejects heartbeat-run issue access for %s", async (_label, actor, status) => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
    });
    mockActivityService.issuesForRun.mockResolvedValue([{ id: "issue-1" }]);

    const response = await request(createApp(actor)).get(
      "/api/heartbeat-runs/run-1/issues",
    );

    expect(response.status).toBe(status);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("returns heartbeat-run issues to an authorized company member", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
    });
    mockActivityService.issuesForRun.mockResolvedValue([{ id: "issue-1" }]);

    const response = await request(createApp()).get(
      "/api/heartbeat-runs/run-1/issues",
    );

    expect(response.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockActivityService.issuesForRun).toHaveBeenCalledWith("run-1");
    expect(response.body).toEqual([{ id: "issue-1" }]);
  });

  it("rejects direct activity creation for a board user from another company", async () => {
    const response = await request(
      createApp({ ...boardActor, companyIds: ["company-2"] }),
    )
      .post("/api/companies/company-1/activity")
      .send({
        actorType: "system",
        actorId: "system-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-1",
      });

    expect(response.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });
});
