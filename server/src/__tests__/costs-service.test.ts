import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/index.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };

  const thenableChain = Object.assign(Promise.resolve([]), selectChain);

  return {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    ...overrides,
  };
}

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());
const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0 }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  budgetService: () => mockBudgetService,
  costService: () => mockCostService,
  financeService: () => mockFinanceService,
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/quota-windows.js", () => ({
  fetchAllQuotaWindows: mockFetchAllQuotaWindows,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

function createAppWithActor(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCompanyService.update.mockResolvedValue({
    id: "company-1",
    name: "Paperclip",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.update.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
});

describe("cost routes", () => {
  it("accepts valid ISO date strings and passes them to cost summary routes", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/summary")
      .query({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T23:59:59.999Z" });
    expect(res.status).toBe(200);
  });

  it("returns 400 for an invalid 'from' date string", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/summary")
      .query({ from: "not-a-date" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid 'from' date/i);
  });

  it("returns 400 for an invalid 'to' date string", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/summary")
      .query({ to: "banana" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid 'to' date/i);
  });

  it("returns finance summary rows for valid requests", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-summary")
      .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-28T23:59:59.999Z" });
    expect(res.status).toBe(200);
    expect(mockFinanceService.summary).toHaveBeenCalled();
  });

  it("returns 400 for invalid finance event list limits", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-events")
      .query({ limit: "0" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid 'limit'/i);
  });

  it("accepts valid finance event list limits", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-events")
      .query({ limit: "25" });
    expect(res.status).toBe(200);
    expect(mockFinanceService.list).toHaveBeenCalledWith("company-1", undefined, 25);
  });

  it("redacts provider credentials from quota rejection responses", async () => {
    const providerCredential =
      "eyJhbGciOiJIUzI1NiJ9.cXVvdGEtcmVqZWN0aW9uLWNhbmFyeQ.c2lnbmF0dXJlLWNhbmFyeQ";
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
    });
    mockFetchAllQuotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        ok: false,
        error: `Error: quota probe stderr contained ${providerCredential}`,
        windows: [],
      },
    ]);

    const app = createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/quota-windows");

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(providerCredential);
    expect(res.body[0]?.error).toBe(
      "Error: quota probe stderr contained ***REDACTED***",
    );
  });

  it("redacts one provider credential split across quota error and window labels", async () => {
    const providerCredential = "quota-provider-cross-field-canary-9e752fd1";
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = providerCredential;
    const splitAt = Math.floor(providerCredential.length / 4);
    const fragments = [
      providerCredential.slice(0, splitAt),
      providerCredential.slice(splitAt, splitAt * 2),
      providerCredential.slice(splitAt * 2, splitAt * 3),
      providerCredential.slice(splitAt * 3),
    ];
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
    });
    mockFetchAllQuotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        ok: false,
        error: fragments[0],
        windows: [
          {
            detail: fragments[1],
            label: fragments[2],
            usedPercent: null,
            resetsAt: null,
            valueLabel: fragments[3],
          },
        ],
      },
    ]);

    try {
      const res = await request(createApp())
        .get("/api/companies/company-1/costs/quota-windows");

      const result = res.body[0];
      const reconstructed = [
        result.error,
        result.windows[0].detail,
        result.windows[0].label,
        result.windows[0].valueLabel,
      ].join("");
      expect(res.status).toBe(200);
      expect(reconstructed).not.toContain(providerCredential);
      expect(JSON.stringify(result)).toContain("***REDACTED***");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("prevents quota fragments from reconstructing across provider records", async () => {
    const token = "eyJquota.providers.signature_";
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
    });
    mockFetchAllQuotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        ok: false,
        error: token.slice(0, 1),
        windows: [],
      },
      {
        provider: "openai",
        ok: true,
        windows: [{
          label: token.slice(1),
          usedPercent: null,
          resetsAt: null,
          valueLabel: null,
          detail: null,
        }],
      },
    ]);

    const response = await request(createApp())
      .get("/api/companies/company-1/costs/quota-windows");

    expect(response.status).toBe(200);
    expect(response.body.map((result: { provider: string; ok: boolean }) => ({
      provider: result.provider,
      ok: result.ok,
    }))).toEqual([
      { provider: "anthropic", ok: false },
      { provider: "openai", ok: true },
    ]);
    expect(`${response.body[0].error}${response.body[1].windows[0].label}`)
      .not.toContain(token);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("rejects company budget updates for board users outside the company", async () => {
    const app = createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates for board users outside the agent company", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 100,
      spentMonthlyCents: 0,
    });
    const app = createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
