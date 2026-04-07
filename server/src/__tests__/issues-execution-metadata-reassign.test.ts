/**
 * Regression tests for TIZA-753: execution metadata cleared on reassign.
 *
 * Bug: when an issue's assigneeAgentId was changed, only checkoutRunId was
 * cleared. The three companion fields — executionRunId, executionAgentNameKey,
 * executionLockedAt — were left pointing at the previous agent's run.  This
 * caused every new-assignee checkout to hit the executionLockCondition and
 * return 409.
 *
 * Fix: issueService.update now clears all four fields whenever the assignee
 * changes (issues.ts ~882).
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
    path.join(os.tmpdir(), "paperclip-execution-metadata-reassign-"),
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

describe("issueService.update — execution metadata cleared on reassign", () => {
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

  async function seedFixture() {
    const companyId = randomUUID();
    const issuePrefix = "TFIX";
    const originalAgentId = randomUUID();
    const newAgentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-04-07T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: originalAgentId,
        companyId,
        name: "Original Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "New Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Seed a heartbeat run so the FK on executionRunId is satisfied.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: originalAgentId,
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

    // Seed the issue with all four execution fields pre-populated, simulating
    // the stale state that caused checkout 409s before the fix.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale execution metadata issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: originalAgentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "original-agent",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, originalAgentId, newAgentId, runId, issueId };
  }

  it("clears all four execution fields when assigneeAgentId changes", async () => {
    const { issueId, newAgentId } = await seedFixture();
    const svc = issueService(db);

    const updated = await svc.update(issueId, { assigneeAgentId: newAgentId });

    expect(updated).not.toBeNull();
    expect(updated?.assigneeAgentId).toBe(newAgentId);
    expect(updated?.checkoutRunId).toBeNull();
    expect(updated?.executionRunId).toBeNull();
    expect(updated?.executionAgentNameKey).toBeNull();
    expect(updated?.executionLockedAt).toBeNull();
  });

  it("does not clear execution fields when assigneeAgentId is unchanged", async () => {
    const { issueId, originalAgentId, runId } = await seedFixture();
    const svc = issueService(db);

    // Update status only — assignee is not changing.
    const updated = await svc.update(issueId, {
      assigneeAgentId: originalAgentId,
      status: "in_progress",
    });

    expect(updated).not.toBeNull();
    expect(updated?.executionRunId).toBe(runId);
    expect(updated?.executionAgentNameKey).toBe("original-agent");
    expect(updated?.executionLockedAt).not.toBeNull();
  });

  it("clears all four execution fields when assignee changes to unassigned", async () => {
    const { issueId } = await seedFixture();
    const svc = issueService(db);

    // Remove agent assignee entirely; drop to blocked to avoid the
    // "in_progress requires assignee" guard.
    const updated = await svc.update(issueId, {
      assigneeAgentId: null,
      status: "blocked",
    });

    expect(updated).not.toBeNull();
    expect(updated?.assigneeAgentId).toBeNull();
    expect(updated?.checkoutRunId).toBeNull();
    expect(updated?.executionRunId).toBeNull();
    expect(updated?.executionAgentNameKey).toBeNull();
    expect(updated?.executionLockedAt).toBeNull();
  });
});
