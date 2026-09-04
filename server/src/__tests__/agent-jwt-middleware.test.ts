import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: mockLoggerWarn },
  requestLogUrl: (req: { originalUrl?: string; url?: string }) =>
    (req.originalUrl || req.url || "").split(/[?#]/, 1)[0] ?? "",
}));

const agent = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "company-1",
  status: "active",
};
const runId = "00000000-0000-4000-8000-000000000002";

function createDb(
  runStatus: string | null,
  runOverrides: Partial<{ id: string; agentId: string; companyId: string }> = {},
) {
  const rowSets = [
    [],
    [agent],
    runStatus === null
      ? []
      : [
          {
            id: runId,
            agentId: agent.id,
            companyId: agent.companyId,
            status: runStatus,
            ...runOverrides,
          },
        ],
  ];
  return {
    select: vi.fn(() => {
      const rows = rowSets.shift() ?? [];
      const query: Record<string, any> = {};
      query.from = vi.fn(() => query);
      query.where = vi.fn(() => Promise.resolve(rows));
      return query;
    }),
  } as any;
}

function createRequest(token: string, runIdHeader?: string) {
  return {
    actor: { type: "none", source: "none" },
    header: vi.fn((name: string) => {
      if (name === "authorization") return `Bearer ${token}`;
      if (name === "x-paperclip-run-id") return runIdHeader;
      return undefined;
    }),
  } as any;
}

describe("run-scoped local agent JWT middleware", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(() => {
    mockLoggerWarn.mockReset();
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "middleware-test-secret-with-sufficient-length";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  it("strips arbitrary query credentials from auth session failure logs", async () => {
    const queryCredential = "opaque-auth-query-credential-canary-624b";
    const processCredential = "auth-process-credential-canary-c7f4";
    const previousAuthSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = processCredential;
    const req = {
      actor: { type: "none", source: "none" },
      method: "GET",
      originalUrl: `/api/session?diagnostic=${queryCredential}`,
      header: vi.fn(() => undefined),
    } as any;

    try {
      await actorMiddleware(createDb(null), {
        deploymentMode: "authenticated",
        resolveSession: vi.fn().mockRejectedValue(
          new Error(`session unavailable for ${processCredential}`),
        ),
      })(req, {} as any, vi.fn());

      expect(mockLoggerWarn).toHaveBeenCalledOnce();
      const fields = mockLoggerWarn.mock.calls[0]?.[0] as any;
      expect(fields).toMatchObject({
        method: "GET",
        url: "/api/session",
        err: {
          name: "Error",
          message: "session unavailable for ***REDACTED***",
        },
      });
      expect(fields.err).not.toHaveProperty("stack");
      expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain(queryCredential);
      expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain(processCredential);
    } finally {
      if (previousAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousAuthSecret;
    }
  });

  it("cannot reconstruct a JWT split across auth error name and message", async () => {
    const credential = "eyJauth.payload.signature_";
    const error = new Error("payload.signature_");
    error.name = "eyJauth.";
    const req = {
      actor: { type: "none", source: "none" },
      method: "GET",
      originalUrl: "/api/session",
      header: vi.fn(() => undefined),
    } as any;

    await actorMiddleware(createDb(null), {
      deploymentMode: "authenticated",
      resolveSession: vi.fn().mockRejectedValue(error),
    })(req, {} as any, vi.fn());

    const fields = mockLoggerWarn.mock.calls[0]?.[0] as any;
    expect(`${fields.err.name}${fields.err.message}`).not.toContain(credential);
    expect(JSON.stringify(fields.err)).toContain("***REDACTED***");
  });

  it.each([
    [
      "throwing accessors",
      new Proxy(new Error("hidden"), {
        get(target, property, receiver) {
          if (property === "name" || property === "message") {
            throw new Error("hostile auth accessor");
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    ],
    [
      "throwing string conversion",
      {
        toString() {
          throw new Error("hostile auth conversion");
        },
      },
    ],
  ])("continues unauthenticated after a session rejection with %s", async (_kind, error) => {
    const req = {
      actor: { type: "none", source: "none" },
      method: "GET",
      originalUrl: "/api/session",
      header: vi.fn(() => undefined),
    } as any;
    const next = vi.fn();

    await actorMiddleware(createDb(null), {
      deploymentMode: "authenticated",
      resolveSession: vi.fn().mockRejectedValue(error),
    })(req, {} as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.actor).toEqual({ type: "none", source: "none" });
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain("hostile auth");
  });

  it.each(["queued", "running"])(
    "accepts the token only while its exact run is %s",
    async (status) => {
      const token = createLocalAgentJwt(agent.id, agent.companyId, "codex_local", runId)!;
      const req = createRequest(token);
      const next = vi.fn();

      await actorMiddleware(createDb(status), { deploymentMode: "authenticated" })(
        req,
        {} as any,
        next,
      );

      expect(next).toHaveBeenCalledOnce();
      expect(req.actor).toMatchObject({
        type: "agent",
        agentId: agent.id,
        companyId: agent.companyId,
        runId,
        source: "agent_jwt",
      });
    },
  );

  it("rejects a valid token when its signed run does not exist", async () => {
    const token = createLocalAgentJwt(agent.id, agent.companyId, "codex_local", runId)!;
    const req = createRequest(token);

    await actorMiddleware(createDb(null), { deploymentMode: "authenticated" })(
      req,
      {} as any,
      vi.fn(),
    );

    expect(req.actor).toEqual({ type: "none", source: "none" });
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"])(
    "rejects a token after its run becomes %s",
    async (status) => {
      const token = createLocalAgentJwt(agent.id, agent.companyId, "codex_local", runId)!;
      const req = createRequest(token);

      await actorMiddleware(createDb(status), { deploymentMode: "authenticated" })(
        req,
        {} as any,
        vi.fn(),
      );

      expect(req.actor).toEqual({ type: "none", source: "none" });
    },
  );

  it("rejects a run header that does not match the signed run", async () => {
    const token = createLocalAgentJwt(agent.id, agent.companyId, "codex_local", runId)!;
    const req = createRequest(token, "00000000-0000-4000-8000-000000000099");

    await actorMiddleware(createDb("running"), { deploymentMode: "authenticated" })(
      req,
      {} as any,
      vi.fn(),
    );

    expect(req.actor).toEqual({ type: "none", source: "none" });
  });

  it.each([
    ["run id", { id: "00000000-0000-4000-8000-000000000099" }],
    ["agent id", { agentId: "00000000-0000-4000-8000-000000000099" }],
    ["company id", { companyId: "company-99" }],
  ])("rejects a running row with a mismatched %s", async (_field, runOverrides) => {
    const token = createLocalAgentJwt(agent.id, agent.companyId, "codex_local", runId)!;
    const req = createRequest(token);

    await actorMiddleware(createDb("running", runOverrides), {
      deploymentMode: "authenticated",
    })(req, {} as any, vi.fn());

    expect(req.actor).toEqual({ type: "none", source: "none" });
  });
});
