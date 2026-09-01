import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentEmulationSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
} from "@paperclipai/db";
import { agentService } from "../services/agents.ts";
import { dashboardService } from "../services/dashboard.ts";
import { heartbeatService } from "../services/heartbeat.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-agent-emulation-"));
  const port = await getAvailablePort();
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("external agent emulation leases", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentEmulationSessions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedAgent(status: "idle" | "paused" | "terminated" | "pending_approval" = "paused") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Lease Test Company",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "External Operator",
      role: "engineer",
      status,
      pauseReason: status === "paused" ? "manual" : null,
      pausedAt: status === "paused" ? new Date() : null,
    });
    return { agentId, companyId };
  }

  it("atomically admits only one active run and refreshes concurrent retries for that run", async () => {
    const { agentId } = await seedAgent();
    const service = agentService(db);

    const competing = await Promise.allSettled([
      service.startEmulation(agentId, { runId: "run-a", ttlSec: 300 }),
      service.startEmulation(agentId, { runId: "run-b", ttlSec: 300 }),
    ]);

    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
    const admittedRun = competing[0]?.status === "fulfilled" ? "run-a" : "run-b";
    await expect(
      Promise.all([
        service.startEmulation(agentId, { runId: admittedRun, ttlSec: 300 }),
        service.startEmulation(agentId, { runId: admittedRun, ttlSec: 300 }),
      ]),
    ).resolves.toHaveLength(2);

    const activeRows = await db
      .select()
      .from(agentEmulationSessions)
      .where(isNull(agentEmulationSessions.endedAt));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.runId).toBe(admittedRun);
  });

  it("preserves native status and makes matching end idempotent without ending another run", async () => {
    const { agentId } = await seedAgent("paused");
    const service = agentService(db);

    const started = await service.startEmulation(agentId, { runId: "run-a", ttlSec: 300 });
    expect(started?.agent).toMatchObject({ status: "under_emulation", nativeStatus: "paused" });

    const wrongRun = await service.endEmulation(agentId, { runId: "run-b", reason: "finished" });
    expect(wrongRun?.ended).toBe(false);
    expect((await service.getById(agentId))?.status).toBe("under_emulation");

    const ended = await service.endEmulation(agentId, { runId: "run-a", reason: "finished" });
    expect(ended?.ended).toBe(true);
    expect(ended?.agent).toMatchObject({ status: "paused", nativeStatus: null });

    const retry = await service.endEmulation(agentId, { runId: "run-a", reason: "finished" });
    expect(retry?.ended).toBe(false);
  });

  it("expires stale leases before admitting a replacement", async () => {
    const { agentId } = await seedAgent();
    const service = agentService(db);
    await service.startEmulation(agentId, { runId: "expired-run", ttlSec: 300 });
    await db
      .update(agentEmulationSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(agentEmulationSessions.agentId, agentId));

    await expect(service.startEmulation(agentId, { runId: "replacement", ttlSec: 300 })).resolves.toBeTruthy();

    const rows = await db
      .select()
      .from(agentEmulationSessions)
      .where(eq(agentEmulationSessions.agentId, agentId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.runId === "expired-run")).toMatchObject({ endedReason: "expired" });
    expect(rows.find((row) => row.runId === "replacement")?.endedAt).toBeNull();
  });

  it("counts effective emulation status without double-counting the native status", async () => {
    const { agentId, companyId } = await seedAgent("paused");
    const service = agentService(db);
    const dashboard = dashboardService(db);
    await service.startEmulation(agentId, { runId: "dashboard-run", ttlSec: 300 });

    expect((await dashboard.summary(companyId)).agents).toMatchObject({
      emulating: 1,
      paused: 0,
    });

    await service.endEmulation(agentId, { runId: "dashboard-run", reason: "finished" });
    expect((await dashboard.summary(companyId)).agents).toMatchObject({
      emulating: 0,
      paused: 1,
    });
  });

  it("reaps dead local clients but leaves active leases without a valid pid to TTL recovery", async () => {
    const dead = await seedAgent();
    const ttlOnly = await seedAgent();
    const service = agentService(db);
    await service.startEmulation(dead.agentId, {
      runId: "dead-run",
      ttlSec: 300,
      metadata: { source: "pcli", pid: 1234 },
    });
    await service.startEmulation(ttlOnly.agentId, {
      runId: "ttl-run",
      ttlSec: 300,
      metadata: { source: "pcli", pid: "not-a-pid" },
    });

    const result = await service.reapEmulations({ isProcessAlive: () => false });

    expect(result).toEqual({ expired: 0, deadClients: 1 });
    expect((await service.getById(dead.agentId))?.status).toBe("paused");
    expect((await service.getById(ttlOnly.agentId))?.status).toBe("under_emulation");
  });

  it("cascades active and historical lease rows when an agent is deleted", async () => {
    const { agentId } = await seedAgent();
    const service = agentService(db);
    await service.startEmulation(agentId, { runId: "old-run", ttlSec: 300 });
    await service.endEmulation(agentId, { runId: "old-run", reason: "finished" });
    await service.startEmulation(agentId, { runId: "active-run", ttlSec: 300 });

    await expect(service.remove(agentId)).resolves.toBeTruthy();
    expect(
      await db.select().from(agentEmulationSessions).where(eq(agentEmulationSessions.agentId, agentId)),
    ).toEqual([]);
  });

  it("blocks manual native invocation and defers already queued native work while leased", async () => {
    const { agentId, companyId } = await seedAgent("idle");
    const agentsService = agentService(db);
    const heartbeats = heartbeatService(db);
    await agentsService.startEmulation(agentId, { runId: "external-run", ttlSec: 300 });

    await expect(heartbeats.invoke(agentId)).rejects.toThrow("external emulation");

    const [queued] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "queued", invocationSource: "on_demand" })
      .returning();
    await heartbeats.resumeQueuedRuns();

    const persisted = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued!.id))
      .then((rows) => rows[0]);
    expect(persisted?.status).toBe("queued");
    expect(persisted?.startedAt).toBeNull();
  });

  it("refuses an external lease while a native heartbeat is already running", async () => {
    const { agentId, companyId } = await seedAgent("idle");
    const service = agentService(db);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "timer",
      startedAt: new Date(),
    });

    await expect(
      service.startEmulation(agentId, { runId: "external-run", ttlSec: 300 }),
    ).rejects.toThrow("native heartbeat");
  });

  it("allows a running emulated heartbeat to acquire its own lease", async () => {
    const { agentId, companyId } = await seedAgent("idle");
    const service = agentService(db);
    const [emulatedRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date(),
        contextSnapshot: { emulated: true },
      })
      .returning();

    await expect(
      service.startEmulation(agentId, { runId: emulatedRun!.id, ttlSec: 300 }),
    ).resolves.toMatchObject({
      agent: { status: "under_emulation" },
      emulation: { runId: emulatedRun!.id },
    });
  });

  it("still rejects a distinct running native heartbeat alongside the caller's emulated run", async () => {
    const { agentId, companyId } = await seedAgent("idle");
    const service = agentService(db);
    const [emulatedRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date(),
        contextSnapshot: { emulated: true },
      })
      .returning();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "timer",
      startedAt: new Date(),
    });

    await expect(
      service.startEmulation(agentId, { runId: emulatedRun!.id, ttlSec: 300 }),
    ).rejects.toThrow("native heartbeat");
  });

  it("does not treat a native run with the supplied ID as an emulated self-run", async () => {
    const { agentId, companyId } = await seedAgent("idle");
    const service = agentService(db);
    const [nativeRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        invocationSource: "timer",
        startedAt: new Date(),
      })
      .returning();

    await expect(
      service.startEmulation(agentId, { runId: nativeRun!.id, ttlSec: 300 }),
    ).rejects.toThrow("native heartbeat");
  });

  it("rejects another agent's emulated run ID", async () => {
    const { agentId } = await seedAgent("idle");
    const other = await seedAgent("idle");
    const service = agentService(db);
    const [foreignEmulatedRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: other.companyId,
        agentId: other.agentId,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date(),
        contextSnapshot: { emulated: true },
      })
      .returning();

    await expect(
      service.startEmulation(agentId, { runId: foreignEmulatedRun!.id, ttlSec: 300 }),
    ).rejects.toThrow("does not belong to target agent");
  });
});
