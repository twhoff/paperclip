import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { systemRoutes } from "../routes/system.js";
import { errorHandler } from "../middleware/index.js";
import type { ShutdownService, ShutdownState } from "../services/shutdown.js";

function idleState(): ShutdownState {
  return {
    phase: "idle",
    startedAt: null,
    deadline: null,
    timeoutMs: 120_000,
    exitProcess: false,
    inFlightAgentCount: 0,
    inFlightAgentIds: [],
    initiatorActorId: null,
  };
}

function drainingState(): ShutdownState {
  return {
    phase: "draining",
    startedAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 60_000).toISOString(),
    timeoutMs: 60_000,
    exitProcess: false,
    inFlightAgentCount: 1,
    inFlightAgentIds: ["agent-1"],
    initiatorActorId: "user-1",
  };
}

function makeShutdown(): ShutdownService {
  return {
    setTargets: vi.fn(),
    initiate: vi.fn(async () => drainingState()),
    resume: vi.fn(async () => idleState()),
    getState: vi.fn(() => idleState()),
    _internal: { tick: vi.fn(), clearTimer: vi.fn() },
  } as unknown as ShutdownService;
}

function buildApp(shutdown: ShutdownService, actorType: "board" | "agent" = "board") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      actorType === "board"
        ? {
          type: "board",
          userId: "local-board",
          companyIds: ["co-1"],
          source: "local_implicit",
          isInstanceAdmin: true,
        }
        : { type: "agent", agentId: "a-1", companyId: "co-1" };
    next();
  });
  app.use("/api/system", systemRoutes(shutdown));
  app.use(errorHandler);
  return app;
}

describe("system routes", () => {
  let shutdown: ShutdownService;

  beforeEach(() => {
    shutdown = makeShutdown();
  });

  it("GET /api/system/shutdown returns current state", async () => {
    const res = await request(buildApp(shutdown)).get("/api/system/shutdown");
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe("idle");
  });

  it("POST /api/system/shutdown initiates with default options", async () => {
    const res = await request(buildApp(shutdown))
      .post("/api/system/shutdown")
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.phase).toBe("draining");
    expect(shutdown.initiate).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "local-board", actorType: "user" }),
    );
  });

  it("POST /api/system/shutdown forwards timeoutMs and exitProcess", async () => {
    await request(buildApp(shutdown))
      .post("/api/system/shutdown")
      .send({ timeoutMs: 30_000, exitProcess: true });
    expect(shutdown.initiate).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000, exitProcess: true }),
    );
  });

  it("POST /api/system/shutdown rejects non-boolean exitProcess", async () => {
    const res = await request(buildApp(shutdown))
      .post("/api/system/shutdown")
      .send({ exitProcess: "yes" });
    expect(res.status).toBe(400);
  });

  it("POST /api/system/shutdown rejects non-numeric timeoutMs", async () => {
    const res = await request(buildApp(shutdown))
      .post("/api/system/shutdown")
      .send({ timeoutMs: "long" });
    expect(res.status).toBe(400);
  });

  it("POST /api/system/shutdown is forbidden for agent actors", async () => {
    const res = await request(buildApp(shutdown, "agent"))
      .post("/api/system/shutdown")
      .send({});
    expect(res.status).toBe(403);
    expect(shutdown.initiate).not.toHaveBeenCalled();
  });

  it("POST /api/system/shutdown/resume invokes service", async () => {
    const res = await request(buildApp(shutdown)).post("/api/system/shutdown/resume");
    expect(res.status).toBe(200);
    expect(shutdown.resume).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "local-board" }),
    );
    expect(res.body.phase).toBe("idle");
  });
});
