/**
 * Regression tests for TIZA-757: rightful assignee blocked by ghost executionRunId.
 *
 * Bug: when checkoutRunId is null but executionRunId has been stamped by
 * heartbeat legacy-run promotion, the rightful assignee gets 409 on both
 * POST /checkout and POST /comments (via assertCheckoutOwner).
 *
 * Fix: checkout() and assertCheckoutOwner() now treat executionRunId as
 * advisory metadata when checkoutRunId is null — the rightful assignee is
 * allowed to proceed.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { issueService } from "../services/issues.ts";

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

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "paperclip-ghost-execution-lock-"),
  );
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
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

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, instance, dataDir };
}

describe("TIZA-757: checkout/comment with ghost executionRunId", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Seed an issue in in_progress with checkoutRunId = null and a ghost
   * executionRunId from a stale heartbeat run belonging to the assignee.
   */
  async function seedGhostLock() {
    const companyId = randomUUID();
    const issuePrefix = "TGHOST";
    const assigneeAgentId = randomUUID();
    const ghostRunId = randomUUID();
    const freshRunId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-04-07T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Ghost Lock Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee Agent",
      role: "engineer",
      status: "running",
      adapterType: "copilot_cli",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Ghost run: stale queued run from a crashed process
    await db.insert(heartbeatRuns).values({
      id: ghostRunId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId },
      processPid: null,
      processLossRetryCount: 0,
      errorCode: null,
      error: null,
      startedAt: null,
      updatedAt: now,
    });

    // Fresh run: the assignee's current run
    await db.insert(heartbeatRuns).values({
      id: freshRunId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      processPid: null,
      processLossRetryCount: 0,
      errorCode: null,
      error: null,
      startedAt: now,
      updatedAt: now,
    });

    // Issue: in_progress, checkoutRunId null, ghost executionRunId set
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ghost-locked issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId,
      checkoutRunId: null,
      executionRunId: ghostRunId,
      executionAgentNameKey: "assignee-agent",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, assigneeAgentId, ghostRunId, freshRunId, issueId };
  }

  it("checkout succeeds for rightful assignee when checkoutRunId is null and ghost executionRunId is set", async () => {
    const { assigneeAgentId, freshRunId, issueId } = await seedGhostLock();

    const svc = issueService(db);
    const result = await svc.checkout(issueId, assigneeAgentId, ["in_progress"], freshRunId);

    expect(result).toBeDefined();
    expect(result.checkoutRunId).toBe(freshRunId);
    expect(result.executionRunId).toBe(freshRunId);
  });

  it("assertCheckoutOwner succeeds for rightful assignee when checkoutRunId is null and ghost executionRunId is set", async () => {
    const { assigneeAgentId, freshRunId, issueId } = await seedGhostLock();

    const svc = issueService(db);
    const result = await svc.assertCheckoutOwner(issueId, assigneeAgentId, freshRunId);

    expect(result).toBeDefined();
    expect(result.assigneeAgentId).toBe(assigneeAgentId);
  });

  it("checkout still blocks non-assignee when real checkoutRunId is set", async () => {
    const companyId = randomUUID();
    const issuePrefix = "TBLOCK";
    const assigneeId = randomUUID();
    const intruderId = randomUUID();
    const ownerRunId = randomUUID();
    const intruderRunId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Block Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: assigneeId,
        companyId,
        name: "Owner",
        role: "engineer",
        status: "running",
        adapterType: "copilot_cli",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: intruderId,
        companyId,
        name: "Intruder",
        role: "engineer",
        status: "running",
        adapterType: "copilot_cli",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: ownerRunId,
        companyId,
        agentId: assigneeId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        processPid: null,
        processLossRetryCount: 0,
        errorCode: null,
        error: null,
        startedAt: now,
        updatedAt: now,
      },
      {
        id: intruderRunId,
        companyId,
        agentId: intruderId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {},
        processPid: null,
        processLossRetryCount: 0,
        errorCode: null,
        error: null,
        startedAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Properly locked issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assigneeId,
      checkoutRunId: ownerRunId,
      executionRunId: ownerRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const svc = issueService(db);
    await expect(
      svc.checkout(issueId, intruderId, ["in_progress"], intruderRunId),
    ).rejects.toThrow(/conflict/i);
  });
});
