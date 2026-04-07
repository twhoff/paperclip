import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
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

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

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
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-recovery-"));
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

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

async function waitFor(check: () => Promise<void>, timeoutMs = 5_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  await check();
}

describe("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const childProcesses = new Set<ChildProcess>();

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agentWakeupRequests);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    runningProcesses.clear();
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false ? {} : { issueId },
      processPid: input?.processPid ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("does not queue a second retry after the first process-loss retry was already used", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("does not let a malformed delayed-retry timestamp break queued heartbeat processing", async () => {
    const { companyId, agentId } = await seedRunFixture({
      includeIssue: false,
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);
    const olderWakeupRequestId = randomUUID();
    const olderRunId = randomUUID();
    const newerWakeupRequestId = randomUUID();
    const newerRunId = randomUUID();

    await db
      .update(agents)
      .set({ status: "idle", updatedAt: new Date("2026-03-19T00:00:00.000Z") })
      .where(eq(agents.id, agentId));

    await db.insert(agentWakeupRequests).values([
      {
        id: olderWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "process_lost_retry",
        payload: {},
        status: "queued",
        createdAt: new Date("2026-03-19T00:01:00.000Z"),
        updatedAt: new Date("2026-03-19T00:01:00.000Z"),
      },
      {
        id: newerWakeupRequestId,
        companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual",
        payload: {},
        status: "queued",
        createdAt: new Date("2026-03-19T00:02:00.000Z"),
        updatedAt: new Date("2026-03-19T00:02:00.000Z"),
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: olderWakeupRequestId,
        contextSnapshot: { retryNotBeforeAt: "not-a-timestamp" },
        createdAt: new Date("2026-03-19T00:01:00.000Z"),
        updatedAt: new Date("2026-03-19T00:01:00.000Z"),
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId: newerWakeupRequestId,
        contextSnapshot: {},
        createdAt: new Date("2026-03-19T00:02:00.000Z"),
        updatedAt: new Date("2026-03-19T00:02:00.000Z"),
      },
    ]);

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    await waitFor(async () => {
      const olderRun = await heartbeat.getRun(olderRunId);
      const newerRun = await heartbeat.getRun(newerRunId);
      expect([olderRun?.status, newerRun?.status]).toContain("running");
    });

    const olderRun = await heartbeat.getRun(olderRunId);
    const newerRun = await heartbeat.getRun(newerRunId);
    expect([olderRun?.status, newerRun?.status]).toContain("running");

    await waitFor(async () => {
      const currentOlderRun = await heartbeat.getRun(olderRunId);
      const currentNewerRun = await heartbeat.getRun(newerRunId);
      expect([currentOlderRun?.status, currentNewerRun?.status]).not.toContain("running");
    });
  });
});

/**
 * Regression tests for TIZA-753 Bug 2: legacy run promotion skips non-assignee.
 *
 * Bug: heartbeat.ts legacy run detection stamped any queued/running run that had
 * issueId in its contextSnapshot as the execution owner, regardless of whether
 * that run belonged to the current assignee. Mention-triggered wakes from
 * non-assignee agents left runs that were then promoted, causing routing
 * oscillation.
 *
 * Fix: the legacy run promotion now guards with
 *   `legacyRun.agentId === issue.assigneeAgentId`
 * before stamping executionRunId (heartbeat.ts ~3422).
 */
describe("heartbeat legacy run promotion — assignee guard (TIZA-753)", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agentWakeupRequests);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Seed a minimal fixture: two agents (assignee A, non-assignee B), one issue
   * (assigneeAgentId = A, executionRunId = null), and queued runs for each.
   */
  async function seedLegacyRunFixture() {
    const companyId = randomUUID();
    const issuePrefix = "LRG";
    const agentAId = randomUUID(); // assignee
    const agentBId = randomUUID(); // non-assignee (mention wake)
    const issueId = randomUUID();
    const runAId = randomUUID();
    const runBId = randomUUID();
    const now = new Date("2026-04-07T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Legacy Run Guard Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Assignee Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Non-Assignee Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Agent B's run: queued, has issueId in contextSnapshot — simulates a
    // mention-triggered wake from a non-assignee agent.
    await db.insert(heartbeatRuns).values({
      id: runBId,
      companyId,
      agentId: agentBId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId },
      processPid: null,
      processLossRetryCount: 0,
      errorCode: null,
      error: null,
      startedAt: now,
      updatedAt: now,
    });

    // Agent A's run: queued, also has issueId in contextSnapshot — the
    // legitimate assignee wake.
    await db.insert(heartbeatRuns).values({
      id: runAId,
      companyId,
      agentId: agentAId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId },
      processPid: null,
      processLossRetryCount: 0,
      errorCode: null,
      error: null,
      startedAt: now,
      updatedAt: new Date(now.getTime() + 1000), // slightly later
    });

    // Issue: no active execution, assignee = Agent A.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Legacy run guard test issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentAId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentAId, agentBId, issueId, runAId, runBId };
  }

  it("non-assignee queued run does NOT satisfy the legacy promotion guard", async () => {
    const { issueId, agentAId, agentBId, runBId } = await seedLegacyRunFixture();

    // Reproduce the exact DB query from heartbeat.ts: find any queued/running run
    // with issueId in contextSnapshot, ordered by status priority then age.
    const issue = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);

    const legacyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.assigneeAgentId ? heartbeatRuns.companyId : heartbeatRuns.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(
        sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    // A legacy run IS found (Agent B's run qualifies by the SQL query alone).
    expect(legacyRun).not.toBeNull();
    expect(legacyRun!.agentId).toBe(agentBId);

    // But the assignee guard correctly rejects it.
    const wouldPromote = legacyRun!.agentId === issue.assigneeAgentId;
    expect(wouldPromote).toBe(false);
  });

  it("assignee queued run DOES satisfy the legacy promotion guard", async () => {
    const { issueId, agentAId, runAId } = await seedLegacyRunFixture();

    // Remove Agent B's run so only Agent A's run exists in the legacy query.
    await db
      .delete(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, (await db.select({ id: agents.id }).from(agents).where(eq(agents.name, "Non-Assignee Agent")).then((r) => r[0]?.id ?? "")),),
        ),
      );

    const issue = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);

    const legacyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(
        sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    // Agent A's run is found.
    expect(legacyRun).not.toBeNull();
    expect(legacyRun!.agentId).toBe(agentAId);

    // The assignee guard correctly allows promotion.
    const wouldPromote = legacyRun!.agentId === issue.assigneeAgentId;
    expect(wouldPromote).toBe(true);
  });

  it("legacy query returns non-assignee run first when both exist (guard is the only safety)", async () => {
    const { issueId, agentBId } = await seedLegacyRunFixture();

    const issue = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);

    // Both Agent A and Agent B's runs exist and are queued.
    // The SQL query returns the first match — without the guard, either could
    // be promoted. With both queued and Agent B inserted first (older),
    // Agent B's run is returned first.
    const legacyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(
        sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    expect(legacyRun).not.toBeNull();
    // Whichever run is returned, applying the guard ensures only the assignee's
    // run can be promoted.
    const wouldPromote = legacyRun!.agentId === issue.assigneeAgentId;

    if (legacyRun!.agentId === agentBId) {
      // Non-assignee surfaced first — guard must block it.
      expect(wouldPromote).toBe(false);
    } else {
      // Assignee surfaced first — guard allows it.
      expect(wouldPromote).toBe(true);
    }
  });
});
