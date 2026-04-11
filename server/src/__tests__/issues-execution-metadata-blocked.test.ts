/**
 * Regression tests for TIZA-820: execution metadata cleared on blocked transition.
 *
 * Bug: when an issue's status was changed to `blocked`, executionRunId,
 * executionAgentNameKey, and executionLockedAt were NOT cleared. This caused
 * gate-held blocked issues to retain stale execution metadata, making them
 * appear active or reserved in PM/EM operational reads.
 *
 * Fix: issueService.update now clears executionRunId, executionAgentNameKey,
 * and executionLockedAt whenever status transitions to `blocked`.
 * startedAt is preserved as historical-only audit metadata.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
    path.join(os.tmpdir(), "paperclip-execution-metadata-blocked-"),
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

describe("issueService.update — execution metadata cleared on blocked transition", () => {
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

  async function seedInProgressIssueWithExecutionMetadata() {
    const companyId = randomUUID();
    const issuePrefix = "TFIX";
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-04-07T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Gate-held issue with stale execution metadata",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "test-agent",
      executionLockedAt: now,
      startedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, runId, issueId, startedAt: now };
  }

  it("clears executionRunId, executionAgentNameKey, and executionLockedAt when transitioning to blocked", async () => {
    const { issueId, agentId } = await seedInProgressIssueWithExecutionMetadata();
    const svc = issueService(db);

    const updated = await svc.update(issueId, {
      status: "blocked",
      assigneeAgentId: agentId,
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("blocked");
    expect(updated?.executionRunId).toBeNull();
    expect(updated?.executionAgentNameKey).toBeNull();
    expect(updated?.executionLockedAt).toBeNull();
  });

  it("preserves startedAt as historical audit metadata when transitioning to blocked", async () => {
    const { issueId, agentId, startedAt } = await seedInProgressIssueWithExecutionMetadata();
    const svc = issueService(db);

    const updated = await svc.update(issueId, {
      status: "blocked",
      assigneeAgentId: agentId,
    });

    expect(updated).not.toBeNull();
    expect(updated?.startedAt).toEqual(startedAt);
  });

  it("does not clear execution metadata when transitioning to in_progress", async () => {
    const { issueId, agentId, runId } = await seedInProgressIssueWithExecutionMetadata();
    const svc = issueService(db);

    const updated = await svc.update(issueId, {
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    expect(updated).not.toBeNull();
    expect(updated?.executionRunId).toBe(runId);
    expect(updated?.executionAgentNameKey).toBe("test-agent");
    expect(updated?.executionLockedAt).not.toBeNull();
  });

  it("clears executionLockedAt when executionRunId is already null (TIZA-703 pattern)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-04-11T01:16:37.649Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co 2",
      issuePrefix: "TFIX2",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent 2",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "TIZA-703 pattern: locked but no runId",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: null,
      executionAgentNameKey: "test-agent-2",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: "TFIX2-1",
    });

    const svc = issueService(db);
    const updated = await svc.update(issueId, {
      status: "blocked",
      assigneeAgentId: agentId,
    });

    expect(updated?.status).toBe("blocked");
    expect(updated?.executionLockedAt).toBeNull();
    expect(updated?.executionAgentNameKey).toBeNull();
  });
});
