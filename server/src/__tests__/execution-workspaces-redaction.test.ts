import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executionWorkspaceRoutes,
  type ExecutionWorkspaceRouteOptions,
} from "../routes/execution-workspaces.js";
import {
  executionWorkspaceService,
  toExecutionWorkspace,
} from "../services/execution-workspaces.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const cleanupSecret = "execution-workspace-cleanup-secret-42";
const capturedPatches: Array<Record<string, unknown>> = [];

const existingWorkspace = {
  id: workspaceId,
  companyId,
  projectId: null,
  projectWorkspaceId: null,
  sourceIssueId: null,
  mode: "isolated",
  strategyType: "local_fs",
  name: "Review workspace",
  status: "active",
  cwd: "/workspace/review",
  repoUrl: null,
  baseRef: null,
  branchName: null,
  providerType: "local_fs",
  providerRef: "/workspace/review",
  derivedFromExecutionWorkspaceId: null,
  lastUsedAt: new Date("2026-09-05T00:00:00.000Z"),
  openedAt: new Date("2026-09-05T00:00:00.000Z"),
  closedAt: null,
  cleanupEligibleAt: null,
  cleanupReason: null,
  metadata: null,
  createdAt: new Date("2026-09-05T00:00:00.000Z"),
  updatedAt: new Date("2026-09-05T00:00:00.000Z"),
};

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockCleanupExecutionWorkspaceArtifacts = vi.hoisted(() => vi.fn());
const mockStopRuntimeServices = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: vi.fn(),
  workspaceOperationService: () => ({
    createRecorder: vi.fn(() => ({ recordOperation: vi.fn() })),
  }),
}));

vi.mock("../services/workspace-runtime.js", () => ({
  cleanupExecutionWorkspaceArtifacts: mockCleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServices,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

function createDbStub(listLimit = vi.fn(async () => [])) {
  const query = {
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: listLimit,
    then<TResult1 = unknown[], TResult2 = never>(
      onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve([]).then(onfulfilled, onrejected);
    },
  };
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => query),
    })),
  };
}

function createSequentialDbStub(rowSets: unknown[][]) {
  let selectIndex = 0;
  return {
    select: vi.fn(() => {
      const rows = rowSets[selectIndex] ?? [];
      selectIndex += 1;
      const query: Record<string, unknown> = {};
      query.leftJoin = vi.fn(() => query);
      query.where = vi.fn(() => query);
      query.orderBy = vi.fn(() => query);
      query.limit = vi.fn(async () => rows);
      query.then = <TResult1 = unknown[], TResult2 = never>(
        onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(rows).then(onfulfilled, onrejected);
      return { from: vi.fn(() => query) };
    }),
  };
}

function createApp(
  db = createDbStub(),
  routeOptions: ExecutionWorkspaceRouteOptions = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes(db as never, routeOptions));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedPatches.length = 0;
  process.env.PAPERCLIP_AGENT_JWT_SECRET = cleanupSecret;
  mockExecutionWorkspaceService.list.mockResolvedValue([]);
  mockExecutionWorkspaceService.getById.mockResolvedValue(existingWorkspace);
  mockExecutionWorkspaceService.update.mockImplementation(
    async (_id: string, patch: Record<string, unknown>) => {
      capturedPatches.push(patch);
      return { ...existingWorkspace, ...patch };
    },
  );
  mockStopRuntimeServices.mockResolvedValue(undefined);
  mockCleanupExecutionWorkspaceArtifacts.mockRejectedValue(
    new Error(`teardown failed after echoing ${cleanupSecret}`),
  );
});

afterEach(() => {
  delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
});

describe("execution workspace cleanup redaction", () => {
  it("redacts diagnostic PATCH fields before persistence", async () => {
    const response = await request(createApp())
      .patch(`/api/execution-workspaces/${workspaceId}`)
      .send({
        cleanupReason: `manual cleanup ${cleanupSecret}`,
        metadata: { apiKey: cleanupSecret },
      });

    expect(response.status).toBe(200);
    expect(capturedPatches).toHaveLength(1);
    expect(JSON.stringify(capturedPatches[0])).not.toContain(cleanupSecret);
    expect(JSON.stringify(capturedPatches[0])).toContain("***REDACTED***");
  });

  it("preserves the metadata record shape when bounded redaction fails closed", async () => {
    let metadata: Record<string, unknown> = { secret: cleanupSecret };
    for (let depth = 0; depth < 40; depth += 1) metadata = { nested: metadata };

    const response = await request(createApp())
      .patch(`/api/execution-workspaces/${workspaceId}`)
      .send({ metadata });

    expect(response.status).toBe(200);
    expect(capturedPatches).toHaveLength(1);
    expect(capturedPatches[0]?.metadata).toEqual({ redacted: "***REDACTED***" });
    expect(JSON.stringify(capturedPatches[0])).not.toContain(cleanupSecret);
  });

  it("caps basic and enriched workspace lists before querying", async () => {
    const enrichedLimit = vi.fn(async () => []);
    const app = createApp(createDbStub(enrichedLimit));

    const basic = await request(app)
      .get(`/api/companies/${companyId}/execution-workspaces?limit=999999`);
    const enriched = await request(app)
      .get(`/api/companies/${companyId}/execution-workspaces?enriched=true&limit=999999`);

    expect(basic.status).toBe(200);
    expect(enriched.status).toBe(200);
    expect(mockExecutionWorkspaceService.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ limit: 500 }),
    );
    expect(enrichedLimit).toHaveBeenCalledWith(500);
  });

  it("applies the default workspace list bound in the service SQL query", async () => {
    const limit = vi.fn(async () => []);
    const query = {
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit,
      then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve([]).then(onfulfilled, onrejected);
      },
    };
    const db = {
      select: () => ({
        from: () => query,
      }),
    };

    await executionWorkspaceService(db as never).list(companyId);

    expect(limit).toHaveBeenCalledWith(200);
  });

  it("keeps operational workspace paths raw until the HTTP response projection", async () => {
    const rawRow = {
      ...existingWorkspace,
      cwd: `/workspace/${cleanupSecret}`,
      providerRef: `/provider/${cleanupSecret}`,
      metadata: { apiKey: cleanupSecret },
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([rawRow]),
        }),
      }),
    };

    const operational = await executionWorkspaceService(db as never).getById(workspaceId);

    expect(operational?.cwd).toBe(rawRow.cwd);
    expect(operational?.providerRef).toBe(rawRow.providerRef);
    expect(operational?.metadata).toEqual(rawRow.metadata);
    expect(JSON.stringify(toExecutionWorkspace(operational as never))).not.toContain(cleanupSecret);
  });

  it("projects raw service workspaces at the HTTP response boundary", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValueOnce({
      ...existingWorkspace,
      cwd: `/workspace/${cleanupSecret}`,
      providerRef: `/provider/${cleanupSecret}`,
      metadata: { apiKey: cleanupSecret },
    });

    const response = await request(createApp())
      .get(`/api/execution-workspaces/${workspaceId}`);

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(cleanupSecret);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("runs Git worktree discovery with an allowlisted environment", async () => {
    const execGit = vi.fn(async () => ({
      stdout: "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n",
      stderr: "",
    }));
    const db = createSequentialDbStub([
      [{ cwd: "/repo" }],
      [{ issuePrefix: "PCL" }],
      [],
      [],
    ]);
    const response = await request(createApp(db, {
      execFile: execGit,
      processEnv: {
        PATH: "/usr/bin",
        HOME: "/home/reviewer",
        PAPERCLIP_AGENT_JWT_SECRET: cleanupSecret,
        GITHUB_TOKEN: "provider-secret",
        CUSTOM_PASSWORD: "password-secret",
      },
    })).get(`/api/companies/${companyId}/projects/project-1/git-worktrees`);

    expect(response.status).toBe(200);
    expect(execGit).toHaveBeenCalledTimes(1);
    expect(execGit.mock.calls[0]?.[2].env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/reviewer",
    });
  });

  it("sanitizes Git removal errors and strips secrets from the child environment", async () => {
    const execGit = vi.fn(async () => {
      throw new Error(`git removal echoed ${cleanupSecret}`);
    });
    const db = createSequentialDbStub([[{ cwd: "/repo" }]]);
    const response = await request(createApp(db, {
      execFile: execGit,
      processEnv: {
        PATH: "/usr/bin",
        PAPERCLIP_AGENT_JWT_SECRET: cleanupSecret,
        GITHUB_TOKEN: "provider-secret",
      },
    }))
      .post(`/api/companies/${companyId}/projects/project-1/git-worktrees/remove`)
      .send({ path: "/repo-review" });

    expect(response.status).toBe(500);
    expect(execGit.mock.calls[0]?.[2].env).toEqual({ PATH: "/usr/bin" });
    expect(JSON.stringify(response.body)).not.toContain(cleanupSecret);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("handles a hostile Git removal rejection without invoking its accessors", async () => {
    const hostile = new Proxy(new Error("hidden"), {
      get(target, property, receiver) {
        if (["name", "message", "stack", "toString"].includes(String(property))) {
          throw new Error("hostile accessor");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const execGit = vi.fn(async () => {
      throw hostile;
    });
    const db = createSequentialDbStub([[{ cwd: "/repo" }]]);

    const response = await request(createApp(db, { execFile: execGit }))
      .post(`/api/companies/${companyId}/projects/project-1/git-worktrees/remove`)
      .send({ path: "/repo-review" });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
    expect(JSON.stringify(response.body)).not.toContain("hostile accessor");
  });

  it("redacts a teardown failure before cleanupReason persistence and the 500 response", async () => {
    const response = await request(createApp())
      .patch(`/api/execution-workspaces/${workspaceId}`)
      .send({ status: "archived" });

    const failurePatch = capturedPatches.at(-1);
    expect(response.status).toBe(500);
    expect(failurePatch?.status).toBe("cleanup_failed");
    expect(String(failurePatch?.cleanupReason)).not.toContain(cleanupSecret);
    expect(String(failurePatch?.cleanupReason)).toContain("***REDACTED***");
    expect(JSON.stringify(response.body)).not.toContain(cleanupSecret);
    expect(JSON.stringify(response.body)).toContain("***REDACTED***");
  });

  it("persists a bounded failure when workspace cleanup rejects with hostile accessors", async () => {
    const hostile = new Proxy(new Error("hidden"), {
      get(target, property, receiver) {
        if (["name", "message", "stack", "toString"].includes(String(property))) {
          throw new Error("hostile accessor");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    mockCleanupExecutionWorkspaceArtifacts.mockRejectedValueOnce(hostile);

    const response = await request(createApp())
      .patch(`/api/execution-workspaces/${workspaceId}`)
      .send({ status: "archived" });

    expect(response.status).toBe(500);
    expect(capturedPatches.at(-1)?.status).toBe("cleanup_failed");
    expect(capturedPatches.at(-1)?.cleanupReason).toBe("***REDACTED***");
    expect(JSON.stringify(response.body)).not.toContain("hostile accessor");
  });

  it("redacts historical cleanupReason values when mapping workspace responses", () => {
    const workspace = toExecutionWorkspace({
      ...existingWorkspace,
      cleanupReason: `historical teardown failure ${cleanupSecret}`,
    } as never);

    expect(workspace.cleanupReason).not.toContain(cleanupSecret);
    expect(workspace.cleanupReason).toContain("***REDACTED***");
    expect(workspace.status).toBe("active");
    expect(workspace.name).toBe("Review workspace");
  });
});
