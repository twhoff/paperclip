import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));

const mockAdapterStatusService = vi.hoisted(() => ({
  resetExpiredStatuses: vi.fn(),
  listAll: vi.fn(),
  getByType: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockAdapter = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncSkills: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  adapterStatusService: () => mockAdapterStatusService,
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => mockAdapter),
  listAdapterModels: vi.fn(),
}));

function createDb(requireBoardApprovalForNewAgents = false) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents,
          },
        ]),
      })),
    })),
  };
}

function createApp(
  db: Record<string, unknown> = createDb(),
  observeError?: (error: unknown) => void,
) {
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
  app.use("/api", agentRoutes(db as any));
  if (observeError) {
    app.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
      observeError(error);
      next(error);
    });
  }
  app.use(errorHandler);
  return app;
}

function makeAgent(adapterType: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig: {},
    permissions: null,
    updatedAt: new Date(),
  };
}

describe("agent skill routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent("claude_local"),
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: { env: {} },
      secretKeys: new Set<string>(),
    });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([
      {
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: "/tmp/paperclip",
        required: true,
        requiredReason: "required",
      },
    ]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) =>
        requested.map((value) =>
          value === "paperclip"
            ? "paperclipai/paperclip/paperclip"
            : value,
        ),
    );
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent("claude_local"),
      adapterConfig: patch.adapterConfig ?? {},
    }));
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeAgent(String(input.adapterType ?? "claude_local")),
      ...input,
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: input.runtimeConfig ?? {},
      budgetMonthlyCents: Number(input.budgetMonthlyCents ?? 0),
      permissions: null,
    }));
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: input.payload ?? {},
    }));
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  it("skips runtime materialization when listing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: false,
    });
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "claude_local",
        config: expect.objectContaining({
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
    );
  });

  it("redacts a resolved HOME secret from a listed skill path while preserving selectors", async () => {
    const resolvedHome = "/private/resolved-home-secret";
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("claude_local"),
      adapterConfig: {
        env: {
          HOME: { type: "secret_ref", secretId: "secret-home" },
        },
      },
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValueOnce({
      config: { env: { HOME: resolvedHome } },
      secretKeys: new Set(["HOME"]),
    });
    mockAdapter.listSkills.mockResolvedValueOnce({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [
        {
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          desired: true,
          managed: true,
          state: "configured",
          sourcePath: `${resolvedHome}/source`,
          targetPath: `${resolvedHome}/.claude/skills/paperclip`,
          detail: "configured",
        },
      ],
      warnings: [],
    });

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterType).toBe("claude_local");
    expect(res.body.entries[0].key).toBe("paperclipai/paperclip/paperclip");
    expect(JSON.stringify(res.body)).not.toContain(resolvedHome);
    expect(JSON.stringify(res.body)).toContain("***REDACTED***");
  });

  it("redacts a resolved HOME secret from a thrown skill-sync error", async () => {
    const resolvedHome = "/private/resolved-home-secret";
    let routedError: unknown = null;
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("claude_local"),
      adapterConfig: {
        env: {
          HOME: { type: "secret_ref", secretId: "secret-home" },
        },
      },
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValueOnce({
      config: { env: { HOME: resolvedHome } },
      secretKeys: new Set(["HOME"]),
    });
    mockAdapter.syncSkills.mockRejectedValueOnce(
      new Error(`Unable to read ${resolvedHome}/.claude/skills`),
    );

    const res = await request(createApp(createDb(), (error) => {
      routedError = error;
    }))
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync")
      .send({ desiredSkills: ["paperclip"] });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(resolvedHome);
    const routedErrorText = routedError instanceof Error
      ? `${routedError.message}\n${routedError.stack ?? ""}`
      : String(routedError);
    expect(routedErrorText).not.toContain(resolvedHome);
    expect(routedErrorText).toContain("***REDACTED***");
  });

  it("skips runtime materialization when listing Copilot skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("copilot_cli"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "copilot_cli",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: false,
    });
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "copilot_cli",
      }),
    );
  });

  it("skips runtime materialization when listing Codex skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("codex_local"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "codex_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: false,
    });
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "codex_local",
      }),
    );
  });

  it("keeps runtime materialization for persistent skill adapters", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("cursor"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "cursor",
      supported: true,
      mode: "persistent",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: true,
    });
  });

  it("skips runtime materialization when syncing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclipai/paperclip/paperclip"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", {
      materializeMissing: false,
    });
    expect(mockAdapter.syncSkills).toHaveBeenCalled();
  });

  it("canonicalizes desired skill references before syncing", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", ["paperclip"]);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("persists canonical desired skills when creating an agent directly", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", ["paperclip"]);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("materializes a managed AGENTS.md for directly created local agents", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are QA.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        adapterType: "claude_local",
      }),
      { "AGENTS.md": "You are QA." },
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
        }),
      }),
    );
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).not.toMatchObject({
      adapterConfig: expect.objectContaining({
        promptTemplate: expect.anything(),
      }),
    });
  });

  it("materializes the bundled CEO instruction set for default CEO agents", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        role: "ceo",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        role: "ceo",
        adapterType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are the CEO."),
        "HEARTBEAT.md": expect.stringContaining("CEO Heartbeat Checklist"),
        "SOUL.md": expect.stringContaining("CEO Persona"),
        "TOOLS.md": expect.stringContaining("# Tools"),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
  });

  it("materializes the bundled default instruction set for non-CEO agents with no prompt template", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        role: "engineer",
        adapterType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("Keep the work moving until it's done."),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
  });

  it("includes canonical desired skills in hire approvals", async () => {
    const db = createDb(true);

    const res = await request(createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.resolveRequestedSkillKeys).toHaveBeenCalledWith("company-1", ["paperclip"]);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          desiredSkills: ["paperclipai/paperclip/paperclip"],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("strictly redacts split JWT fragments from hire approval responses", async () => {
    const token = "eyJhire_payload.signature_value";

    const res = await request(createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: token.slice(0, 2),
        title: token.slice(2),
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(`${res.body.approval.payload.name}${res.body.approval.payload.title}`).not.toContain(token);
    expect(JSON.stringify(res.body.approval)).toContain("***REDACTED***");
    expect(res.body.agent.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("uses managed AGENTS config in hire approval payloads", async () => {
    const res = await request(createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are QA.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          adapterConfig: expect.objectContaining({
            instructionsBundleMode: "managed",
            instructionsEntryFile: "AGENTS.md",
            instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
          }),
        }),
      }),
    );
    const approvalInput = mockApprovalService.create.mock.calls.at(-1)?.[1] as
      | { payload?: { adapterConfig?: Record<string, unknown> } }
      | undefined;
    expect(approvalInput?.payload?.adapterConfig?.promptTemplate).toBeUndefined();
  });
});
