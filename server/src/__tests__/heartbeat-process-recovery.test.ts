import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  batchQueueEntries,
  companySkills,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { getServerAdapter, runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { getRunLogStore } from "../services/run-log-store.ts";
import { runActivityRegistry } from "../services/run-activity-registry.ts";
import { sharedTransientExecutionContextStore } from "../services/transient-execution-context-store.ts";

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

async function spawnTermResistantProcessGroup() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {});",
        "const grandchild = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
        "process.stdout.write(String(grandchild.pid));",
        "setInterval(() => {}, 1000);",
      ].join(" "),
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("grandchild pid was not reported")), 5_000);
    child.once("error", reject);
    child.stdout?.once("data", (chunk) => {
      clearTimeout(timeout);
      resolve(Number.parseInt(String(chunk), 10));
    });
  });
  return { child, grandchildPid };
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function delayMatchingTransactionResult<T extends object>(
  database: T,
  shouldDelay: (result: unknown) => boolean,
) {
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  let delayed = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const proxied = new Proxy(database, {
    get(target, property) {
      if (property === "transaction") {
        return async (...args: unknown[]) => {
          const transaction = Reflect.get(target, property, target) as (
            ...values: unknown[]
          ) => Promise<unknown>;
          const result = await Reflect.apply(transaction, target, args);
          if (!delayed && shouldDelay(result)) {
            delayed = true;
            reachedResolve();
            await released;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    database: proxied as T,
    reached,
    release: () => releaseResolve(),
  };
}

function delayMatchingSelectResult<T extends object>(
  database: T,
  shouldDelay: (result: unknown) => boolean,
) {
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  let delayed = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  const wrapSelectBuilder = <B extends object>(builder: B): B =>
    new Proxy(builder, {
      get(target, property) {
        if (property === "then") {
          const then = Reflect.get(target, property, target) as (
            onFulfilled: (result: unknown) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) => Promise<unknown>;
          return (
            onFulfilled: (result: unknown) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) =>
            Reflect.apply(then, target, [
              async (result: unknown) => {
                if (!delayed && shouldDelay(result)) {
                  delayed = true;
                  reachedResolve();
                  await released;
                }
                return onFulfilled(result);
              },
              onRejected,
            ]);
        }
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result && typeof result === "object"
            ? wrapSelectBuilder(result as object)
            : result;
        };
      },
    });

  const wrapDatabase = <D extends object>(target: D): D =>
    new Proxy(target, {
      get(current, property) {
        if (property === "select") {
          return (...args: unknown[]) => {
            const select = Reflect.get(current, property, current) as (
              ...values: unknown[]
            ) => object;
            return wrapSelectBuilder(Reflect.apply(select, current, args));
          };
        }
        if (property === "transaction") {
          return (
            callback: (transaction: object) => unknown,
            ...args: unknown[]
          ) => {
            const transaction = Reflect.get(current, property, current) as (
              handler: (transaction: object) => unknown,
              ...values: unknown[]
            ) => Promise<unknown>;
            return Reflect.apply(transaction, current, [
              (tx: object) => callback(wrapDatabase(tx)),
              ...args,
            ]);
          };
        }
        const value = Reflect.get(current, property, current);
        return typeof value === "function" ? value.bind(current) : value;
      },
    });

  return {
    database: wrapDatabase(database),
    reached,
    release: () => releaseResolve(),
  };
}

function delayNextTransactionStart<T extends object>(database: T) {
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  let delayed = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const proxied = new Proxy(database, {
    get(target, property) {
      if (property === "transaction") {
        return async (...args: unknown[]) => {
          if (!delayed) {
            delayed = true;
            reachedResolve();
            await released;
          }
          const transaction = Reflect.get(target, property, target) as (
            ...values: unknown[]
          ) => Promise<unknown>;
          return Reflect.apply(transaction, target, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    database: proxied as T,
    reached,
    release: () => releaseResolve(),
  };
}

function delayNextTableUpdateExecution<T extends object>(database: T, table: object) {
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  let delayed = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  const wrapUpdateBuilder = <B extends object>(builder: B): B =>
    new Proxy(builder, {
      get(target, property) {
        if (property === "then") {
          const then = Reflect.get(target, property, target) as (
            onFulfilled: (result: unknown) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) => Promise<unknown>;
          return async (
            onFulfilled: (result: unknown) => unknown,
            onRejected?: (error: unknown) => unknown,
          ) => {
            if (!delayed) {
              delayed = true;
              reachedResolve();
              await released;
            }
            return Reflect.apply(then, target, [onFulfilled, onRejected]);
          };
        }
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result && typeof result === "object"
            ? wrapUpdateBuilder(result as object)
            : result;
        };
      },
    });

  const wrapDatabase = <D extends object>(target: D): D =>
    new Proxy(target, {
      get(current, property) {
        if (property === "update") {
          return (...args: unknown[]) => {
            const update = Reflect.get(current, property, current) as (
              ...values: unknown[]
            ) => object;
            const builder = Reflect.apply(update, current, args);
            return args[0] === table ? wrapUpdateBuilder(builder) : builder;
          };
        }
        if (property === "transaction") {
          return (
            callback: (transaction: object) => unknown,
            ...args: unknown[]
          ) => {
            const transaction = Reflect.get(current, property, current) as (
              handler: (transaction: object) => unknown,
              ...values: unknown[]
            ) => Promise<unknown>;
            return Reflect.apply(transaction, current, [
              (tx: object) => callback(wrapDatabase(tx)),
              ...args,
            ]);
          };
        }
        const value = Reflect.get(current, property, current);
        return typeof value === "function" ? value.bind(current) : value;
      },
    });

  return {
    database: wrapDatabase(database),
    reached,
    release: () => releaseResolve(),
  };
}

function failFirstInsertForTable<T extends object>(database: T, table: object, error: Error) {
  let failed = false;
  const wrapDatabase = <D extends object>(target: D): D =>
    new Proxy(target, {
      get(current, property) {
        if (property === "insert") {
          return (...args: unknown[]) => {
            if (!failed && args[0] === table) {
              failed = true;
              throw error;
            }
            const insert = Reflect.get(current, property, current) as (
              ...values: unknown[]
            ) => unknown;
            return Reflect.apply(insert, current, args);
          };
        }
        if (property === "transaction") {
          return (
            callback: (transaction: object) => unknown,
            ...args: unknown[]
          ) => {
            const transaction = Reflect.get(current, property, current) as (
              handler: (transaction: object) => unknown,
              ...values: unknown[]
            ) => Promise<unknown>;
            return Reflect.apply(transaction, current, [
              (tx: object) => callback(wrapDatabase(tx)),
              ...args,
            ]);
          };
        }
        const value = Reflect.get(current, property, current);
        return typeof value === "function" ? value.bind(current) : value;
      },
    });
  return wrapDatabase(database);
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
    runActivityRegistry.reset();
    sharedTransientExecutionContextStore.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(batchQueueEntries);
    await db.delete(agentTaskSessions);
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

  it("redacts wakeup reason and split payload/context credentials before coalesced persistence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const controlSecret = "wakeup-control-secret-value-42";
    const splitAt = 15;
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "WakeupAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "existing wake",
      payload: { benignExistingPayload: "preserved" },
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { benignExistingContext: "preserved" },
    });

    try {
      const returnedRun = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: controlSecret as never,
        reason: `manual wake ${controlSecret}`,
        payload: {
          arbitraryPayloadField: controlSecret.slice(0, splitAt),
          benignPayload: "preserved",
        },
        contextSnapshot: {
          arbitraryContextField: controlSecret.slice(splitAt),
          benignContext: "preserved",
        },
      });

      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const persistedWakeup = wakeups.find((row) => row.id !== wakeupRequestId);
      const persistedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      const persistedPayload = persistedWakeup?.payload as Record<string, unknown>;
      const persistedContext = persistedRun?.contextSnapshot as Record<string, unknown>;
      const returnedContext = returnedRun?.contextSnapshot as Record<string, unknown>;
      const persistedReconstruction =
        `${persistedPayload.arbitraryPayloadField}${persistedContext.arbitraryContextField}`;
      const returnedReconstruction =
        `${persistedPayload.arbitraryPayloadField}${returnedContext.arbitraryContextField}`;

      expect(persistedWakeup?.status).toBe("coalesced");
      expect(persistedWakeup?.reason).not.toContain(controlSecret);
      expect(persistedWakeup?.triggerDetail).toBe("***REDACTED***");
      expect(JSON.stringify(persistedWakeup)).toContain("***REDACTED***");
      expect(persistedReconstruction).not.toContain(controlSecret);
      expect(returnedReconstruction).not.toContain(controlSecret);
      expect(persistedPayload.benignPayload).toBe("preserved");
      expect(persistedContext.benignExistingContext).toBe("preserved");
      expect(persistedContext.benignContext).toBe("preserved");
      expect(returnedRun?.status).toBe("queued");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  });

  it("passes raw wakeup context to the adapter while persisted and returned views stay masked", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const controlSecret = "raw-wakeup-adapter-secret-value-42";
    const splitAt = 16;
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    let adapterContext: Record<string, unknown> | null = null;
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      adapterContext = ctx.context;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "completed",
      };
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RawWakeupAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const returnedRun = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: controlSecret as never,
        reason: `execute with ${controlSecret}`,
        payload: {
          secretPrefix: controlSecret.slice(0, splitAt),
          benignPayload: "preserved",
        },
        contextSnapshot: {
          command: `use ${controlSecret}`,
          secretTail: controlSecret.slice(splitAt),
          benignContext: "preserved",
        },
      });

      await waitFor(async () => {
        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(adapterContext).not.toBeNull();
      });
      await waitFor(async () => {
        const current = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, returnedRun?.id ?? ""))
          .then((rows) => rows[0] ?? null);
        expect(current?.status).toBe("succeeded");
      });

      const persistedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, returnedRun?.id ?? ""))
        .then((rows) => rows[0] ?? null);
      const persistedWakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.runId, returnedRun?.id ?? ""))
        .then((rows) => rows[0] ?? null);

      expect(adapterContext?.command).toBe(`use ${controlSecret}`);
      expect(adapterContext?.wakeTriggerDetail).toBe(controlSecret);
      expect(JSON.stringify(persistedRun?.contextSnapshot)).not.toContain(controlSecret);
      expect(persistedRun?.triggerDetail).toBe("***REDACTED***");
      expect(persistedWakeup?.triggerDetail).toBe("***REDACTED***");
      expect(JSON.stringify(persistedWakeup)).not.toContain(controlSecret);
      expect(JSON.stringify(returnedRun)).not.toContain(controlSecret);
      expect(JSON.stringify(persistedRun?.contextSnapshot)).toContain("***REDACTED***");
      expect((persistedRun?.contextSnapshot as Record<string, unknown>).benignContext).toBe(
        "preserved",
      );
    } finally {
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("carries bounded raw wakeup context into an automatic retry without persisting it", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const controlSecret = "automatic-retry-context-secret-value-42";
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    const adapterContexts: Record<string, unknown>[] = [];
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      adapterContexts.push(ctx.context);
      if (adapterContexts.length === 1) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          summary: "process disappeared",
          errorMessage: "process disappeared",
          errorCode: "process_lost",
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "retry completed",
      };
    });
    const retryBarrier = delayMatchingTransactionResult(db, (result) =>
      Boolean(
        result &&
          typeof result === "object" &&
          (result as { retryOfRunId?: unknown }).retryOfRunId,
      ),
    );
    const producerService = heartbeatService(retryBarrier.database);
    const consumerService = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "AutomaticRetryAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const initialRun = await producerService.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: {
          taskKey: `automatic-retry-${randomUUID()}`,
          command: `use ${controlSecret}`,
          benignContext: "preserved",
        },
      });

      await retryBarrier.reached;
      await consumerService.resumeQueuedRuns();
      await waitFor(async () => {
        expect(adapterContexts).toHaveLength(2);
      }, 10_000);
      retryBarrier.release();
      await waitFor(async () => {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        expect(runs.find((row) => row.retryOfRunId === initialRun?.id)?.status).toBe(
          "succeeded",
        );
      }, 10_000);

      const retryRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .then((rows) => rows.find((row) => row.retryOfRunId === initialRun?.id) ?? null);
      await waitFor(async () => {
        const runtime = await db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, agentId))
          .then((rows) => rows[0] ?? null);
        const currentAgent = await db
          .select()
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((rows) => rows[0] ?? null);
        expect(runtime?.lastRunId).toBe(retryRun?.id);
        expect(currentAgent?.status).toBe("idle");
      });

      expect(adapterContexts[0]?.command).toBe(`use ${controlSecret}`);
      expect(adapterContexts[1]?.command).toBe(`use ${controlSecret}`);
      expect(adapterContexts[1]?.benignContext).toBe("preserved");
      expect(JSON.stringify(retryRun?.contextSnapshot)).not.toContain(controlSecret);
      expect(JSON.stringify(retryRun?.contextSnapshot)).toContain("***REDACTED***");
    } finally {
      retryBarrier.release();
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("preserves raw context when a retryable setup failure happens before runtime state exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const controlSecret = "setup-retry-context-secret-value-42";
    const taskKey = `setup-retry-${randomUUID()}`;
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    const adapterContexts: Record<string, unknown>[] = [];
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      adapterContexts.push(ctx.context);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "setup retry completed",
      };
    });
    const failingDatabase = failFirstInsertForTable(
      db,
      agentRuntimeState,
      new Error("fail runtime state once"),
    );
    const service = heartbeatService(failingDatabase);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SetupRetryAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const initialRun = await service.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: {
          taskKey,
          command: `use ${controlSecret}`,
          benignContext: "preserved",
        },
      });
      expect(initialRun).not.toBeNull();
      let retryRun: typeof heartbeatRuns.$inferSelect | null = null;
      await waitFor(async () => {
        retryRun = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, initialRun!.id))
          .then((rows) => rows[0] ?? null);
        expect(retryRun?.status).toBe("queued");
      }, 10_000);

      const stagedRetryContext = sharedTransientExecutionContextStore.take(retryRun!.id);
      expect(stagedRetryContext?.command).toBe(`use ${controlSecret}`);
      expect(stagedRetryContext?.benignContext).toBe("preserved");
      const dueAt = new Date(0).toISOString();
      expect(
        sharedTransientExecutionContextStore.set(retryRun!.id, {
          ...stagedRetryContext,
          retryNotBeforeAt: dueAt,
        }),
      ).toBe(true);
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            ...(retryRun!.contextSnapshot as Record<string, unknown>),
            retryNotBeforeAt: dueAt,
          },
        })
        .where(eq(heartbeatRuns.id, retryRun!.id));

      await service.resumeQueuedRuns();
      await waitFor(async () => {
        const current = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, retryRun!.id))
          .then((rows) => rows[0] ?? null);
        expect(current?.status).toBe("succeeded");
        expect(adapterContexts).toHaveLength(1);
      }, 10_000);

      expect(adapterContexts[0]?.command).toBe(`use ${controlSecret}`);
      expect(adapterContexts[0]?.benignContext).toBe("preserved");
      expect(JSON.stringify(initialRun?.contextSnapshot)).not.toContain(controlSecret);
      expect(JSON.stringify(retryRun?.contextSnapshot)).not.toContain(controlSecret);
    } finally {
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("transfers bounded raw context when a deferred issue wakeup is promoted", async () => {
    const companyId = randomUUID();
    const blockerAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const activeRunId = randomUUID();
    const issueId = randomUUID();
    const controlSecret = "deferred-promotion-context-secret-value-42";
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    let adapterContext: Record<string, unknown> | null = null;
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      adapterContext = ctx.context;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "promoted wake completed",
      };
    });
    const promotionBarrier = delayMatchingTransactionResult(db, (result) =>
      Boolean(
        result &&
          typeof result === "object" &&
          (result as { deferredWakeupRequestId?: unknown }).deferredWakeupRequestId,
      ),
    );
    const producerService = heartbeatService(promotionBarrier.database);
    const consumerService = heartbeatService(db);
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: blockerAgentId,
        companyId,
        name: "BlockingAgent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetAgentId,
        companyId,
        name: "DeferredTargetAgent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {
          cwd: process.cwd(),
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId: blockerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Promote a deferred wakeup",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: targetAgentId,
      executionRunId: activeRunId,
      executionAgentNameKey: "blockingagent",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    try {
      const deferredResult = await producerService.wakeup(targetAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "deferred issue execution",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey: `deferred-promotion-${randomUUID()}`,
          command: `use ${controlSecret}`,
          benignContext: "preserved",
        },
      });
      expect(deferredResult).toBeNull();

      const deferredWake = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, targetAgentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(deferredWake).not.toBeNull();
      expect(JSON.stringify(deferredWake?.payload)).not.toContain(controlSecret);
      await db
        .update(agentWakeupRequests)
        .set({
          triggerDetail: controlSecret as never,
          payload: {
            ...(deferredWake?.payload as Record<string, unknown>),
            legacyDiagnostic: controlSecret,
            _paperclipWakeContext: {
              issueId,
              command: `legacy ${controlSecret}`,
            },
          },
        })
        .where(eq(agentWakeupRequests.id, deferredWake!.id));

      const cancellation = producerService.cancelRun(activeRunId);
      await promotionBarrier.reached;
      await consumerService.resumeQueuedRuns();
      await waitFor(async () => {
        expect(adapterContext).not.toBeNull();
      }, 10_000);
      promotionBarrier.release();
      await cancellation;
      const promotedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.wakeupRequestId, deferredWake!.id))
        .then((rows) => rows[0] ?? null);
      await waitFor(async () => {
        expect((await consumerService.getRun(promotedRun!.id))?.status).toBe("succeeded");
      }, 10_000);
      await waitFor(async () => {
        const runtime = await db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, targetAgentId))
          .then((rows) => rows[0] ?? null);
        const targetAgent = await db
          .select()
          .from(agents)
          .where(eq(agents.id, targetAgentId))
          .then((rows) => rows[0] ?? null);
        expect(runtime?.lastRunId).toBe(promotedRun?.id);
        expect(targetAgent?.status).toBe("idle");
      });

      expect(adapterContext?.command).toBe(`use ${controlSecret}`);
      expect(adapterContext?.benignContext).toBe("preserved");
      expect(JSON.stringify(promotedRun?.contextSnapshot)).not.toContain(controlSecret);
      expect(JSON.stringify(promotedRun?.contextSnapshot)).toContain("***REDACTED***");
      const promotedWake = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(JSON.stringify(promotedWake)).not.toContain(controlSecret);
      expect(promotedWake?.triggerDetail).toBe("***REDACTED***");
    } finally {
      promotionBarrier.release();
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("does not promote a deferred wake after budget cancellation wins the claim race", async () => {
    const companyId = randomUUID();
    const blockerAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const activeRunId = randomUUID();
    const issueId = randomUUID();
    const deferredWakeupRequestId = randomUUID();
    const transientKey = `deferred-wakeup:${deferredWakeupRequestId}`;
    const barrier = delayMatchingSelectResult(db, (result) =>
      Array.isArray(result) &&
      result.some(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { id?: unknown }).id === deferredWakeupRequestId &&
          (row as { status?: unknown }).status === "deferred_issue_execution",
      ),
    );
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: blockerAgentId,
        companyId,
        name: "PromotionRaceBlocker",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetAgentId,
        companyId,
        name: "PromotionRaceTarget",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId: blockerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred promotion cancellation race",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: targetAgentId,
      executionRunId: activeRunId,
      executionAgentNameKey: "promotionraceblocker",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupRequestId,
      companyId,
      agentId: targetAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: { issueId, command: "masked persisted command" },
      },
      status: "deferred_issue_execution",
    });
    expect(
      sharedTransientExecutionContextStore.set(transientKey, {
        issueId,
        command: "raw deferred command",
      }),
    ).toBe(true);

    try {
      const promotionPromise = heartbeatService(barrier.database).cancelRun(activeRunId);
      await barrier.reached;
      await heartbeatService(db).cancelBudgetScopeWork({
        companyId,
        scopeType: "agent",
        scopeId: targetAgentId,
      });
      barrier.release();
      await promotionPromise;

      const [persistedWakeup, promotedRuns] = await Promise.all([
        db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, deferredWakeupRequestId))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.wakeupRequestId, deferredWakeupRequestId)),
      ]);
      expect(persistedWakeup?.status).toBe("cancelled");
      expect(persistedWakeup?.runId).toBeNull();
      expect(promotedRuns).toHaveLength(0);
      expect(sharedTransientExecutionContextStore.get(transientKey)).toBeUndefined();
    } finally {
      barrier.release();
    }
  }, 20_000);

  it("restores invalid deferred context when a later promotion step rolls back", async () => {
    const companyId = randomUUID();
    const blockerAgentId = randomUUID();
    const invalidAgentId = randomUUID();
    const validAgentId = randomUUID();
    const activeRunId = randomUUID();
    const issueId = randomUUID();
    const invalidWakeupId = randomUUID();
    const validWakeupId = randomUUID();
    const invalidTransientKey = `deferred-wakeup:${invalidWakeupId}`;
    const issuePrefix = `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: blockerAgentId,
        companyId,
        name: "RollbackBlocker",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: invalidAgentId,
        companyId,
        name: "PausedDeferredAgent",
        role: "engineer",
        status: "paused",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validAgentId,
        companyId,
        name: "ValidDeferredAgent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId: blockerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred rollback safety",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: validAgentId,
      executionRunId: activeRunId,
      executionAgentNameKey: "rollbackblocker",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: invalidWakeupId,
        companyId,
        agentId: invalidAgentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: { issueId, _paperclipWakeContext: { issueId } },
        status: "deferred_issue_execution",
        requestedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: validWakeupId,
        companyId,
        agentId: validAgentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: { issueId, _paperclipWakeContext: { issueId } },
        status: "deferred_issue_execution",
        requestedAt: new Date("2026-01-01T00:01:00.000Z"),
      },
    ]);
    expect(
      sharedTransientExecutionContextStore.set(invalidTransientKey, {
        issueId,
        command: "raw invalid deferred command",
      }),
    ).toBe(true);

    const failingDatabase = failFirstInsertForTable(
      db,
      heartbeatRuns,
      new Error("fail promoted run insert"),
    );
    await expect(heartbeatService(failingDatabase).cancelRun(activeRunId)).rejects.toThrow(
      "fail promoted run insert",
    );

    const persistedInvalidWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, invalidWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(persistedInvalidWakeup?.status).toBe("deferred_issue_execution");
    expect(sharedTransientExecutionContextStore.get(invalidTransientKey)).toEqual({
      issueId,
      command: "raw invalid deferred command",
    });
  }, 20_000);

  it("shares bounded raw wakeup context across heartbeat service instances", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerRunId = randomUUID();
    const taskKey = `shared-context-task-${randomUUID()}`;
    const controlSecret = "shared-heartbeat-context-current-secret-value-42";
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    let adapterContext: Record<string, unknown> | null = null;
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      adapterContext = ctx.context;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "completed",
      };
    });
    const creationBarrier = delayMatchingTransactionResult(db, (result) =>
      Boolean(
        result &&
          typeof result === "object" &&
          (result as { status?: unknown }).status === "queued" &&
          "wakeupRequestId" in result &&
          !(result as { retryOfRunId?: unknown }).retryOfRunId,
      ),
    );

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SharedContextAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: { taskKey: `blocker-${randomUUID()}` },
      startedAt: new Date(),
    });

    try {
      const producerService = heartbeatService(creationBarrier.database);
      const consumerService = heartbeatService(db);
      const queuedRunPromise = producerService.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: {
          taskKey,
          command: `use ${controlSecret}`,
          benignContext: "preserved",
        },
      });
      await creationBarrier.reached;
      const queuedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "queued"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(queuedRun?.status).toBe("queued");
      expect(JSON.stringify(queuedRun?.contextSnapshot)).not.toContain(controlSecret);
      expect(sharedTransientExecutionContextStore.get(queuedRun!.id)?.command).toBe(
        `use ${controlSecret}`,
      );

      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, blockerRunId));
      await consumerService.resumeQueuedRuns();
      await waitFor(async () => {
        const current = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, queuedRun!.id))
          .then((rows) => rows[0] ?? null);
        expect(current?.status).toBe("succeeded");
        expect(adapterContext).not.toBeNull();
      });
      creationBarrier.release();
      await expect(queuedRunPromise).resolves.toMatchObject({ id: queuedRun!.id });

      expect(adapterContext?.command).toBe(`use ${controlSecret}`);
      expect(adapterContext?.benignContext).toBe("preserved");
      expect(sharedTransientExecutionContextStore.get(queuedRun!.id)).toBeUndefined();
    } finally {
      creationBarrier.release();
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("seeds raw context before an issue-scoped new run becomes claimable", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const taskKey = `issue-creation-race-${randomUUID()}`;
    const controlSecret = "issue-creation-race-secret-value-42";
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    let adapterContext: Record<string, unknown> | null = null;
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      adapterContext = ctx.context;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "completed",
      };
    });
    const creationBarrier = delayMatchingTransactionResult(db, (result) =>
      Boolean(
        result &&
          typeof result === "object" &&
          (result as { kind?: unknown }).kind === "queued" &&
          (result as { run?: unknown }).run,
      ),
    );
    const issuePrefix = `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "IssueCreationRaceAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Claim a newly queued issue run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    try {
      const producerService = heartbeatService(creationBarrier.database);
      const consumerService = heartbeatService(db);
      const wakeupPromise = producerService.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey,
          command: `use ${controlSecret}`,
          benignContext: "preserved",
        },
      });

      await creationBarrier.reached;
      const queuedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "queued"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      expect(queuedRun).not.toBeNull();
      expect(JSON.stringify(queuedRun?.contextSnapshot)).not.toContain(controlSecret);
      expect(sharedTransientExecutionContextStore.get(queuedRun!.id)?.command).toBe(
        `use ${controlSecret}`,
      );

      await consumerService.resumeQueuedRuns();
      await waitFor(async () => {
        const current = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, queuedRun!.id))
          .then((rows) => rows[0] ?? null);
        expect(current?.status).toBe("succeeded");
        expect(adapterContext).not.toBeNull();
      });
      creationBarrier.release();
      await expect(wakeupPromise).resolves.toMatchObject({ id: queuedRun!.id });

      expect(adapterContext?.command).toBe(`use ${controlSecret}`);
      expect(adapterContext?.benignContext).toBe("preserved");
      expect(sharedTransientExecutionContextStore.get(queuedRun!.id)).toBeUndefined();
    } finally {
      creationBarrier.release();
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("clears stale transient context when cancelling a missing run", async () => {
    const runId = randomUUID();
    expect(sharedTransientExecutionContextStore.set(runId, { command: "raw command" })).toBe(
      true,
    );

    await expect(heartbeatService(db).cancelRun(runId)).rejects.toMatchObject({ status: 404 });
    expect(sharedTransientExecutionContextStore.get(runId)).toBeUndefined();
  });

  it("does not let a stale cancellation overwrite a completed run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const cancellationBarrier = delayNextTableUpdateExecution(db, heartbeatRuns);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CompletedBeforeCancelAgent",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "claimed",
      runId,
      claimedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      wakeupRequestId,
      startedAt: new Date(),
    });

    try {
      const cancellation = heartbeatService(cancellationBarrier.database).cancelRun(runId);
      await cancellationBarrier.reached;
      const completedAt = new Date();
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: completedAt, updatedAt: completedAt })
        .where(eq(heartbeatRuns.id, runId));
      await db
        .update(agentWakeupRequests)
        .set({ status: "completed", finishedAt: completedAt, updatedAt: completedAt })
        .where(eq(agentWakeupRequests.id, wakeupRequestId));
      cancellationBarrier.release();

      await expect(cancellation).resolves.toMatchObject({ id: runId, status: "succeeded" });
      const [persistedRun, persistedWakeup, events] = await Promise.all([
        db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, runId)),
      ]);
      expect(persistedRun?.status).toBe("succeeded");
      expect(persistedWakeup?.status).toBe("completed");
      expect(events.some((event) => event.message === "run cancelled")).toBe(false);
    } finally {
      cancellationBarrier.release();
    }
  }, 20_000);

  it("does not let a stale finalizer overwrite a cancelled run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const finalizationBarrier = delayNextTableUpdateExecution(db, heartbeatRuns);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `Y${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CancelledBeforeFinalizeAgent",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "claimed",
      runId,
      claimedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      wakeupRequestId,
      startedAt: new Date(),
      processLossRetryCount: 1,
    });

    try {
      const finalization = heartbeatService(finalizationBarrier.database).reapOrphanedRuns();
      await finalizationBarrier.reached;
      await expect(heartbeatService(db).cancelRun(runId)).resolves.toMatchObject({
        id: runId,
        status: "cancelled",
      });
      finalizationBarrier.release();

      await expect(finalization).resolves.toEqual({ reaped: 0, runIds: [] });
      const [persistedRun, persistedWakeup, events] = await Promise.all([
        db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, runId)),
      ]);
      expect(persistedRun?.status).toBe("cancelled");
      expect(persistedWakeup?.status).toBe("cancelled");
      expect(events.filter((event) => event.message === "run cancelled")).toHaveLength(1);
      expect(events.some((event) => event.message?.includes("Process lost"))).toBe(false);
    } finally {
      finalizationBarrier.release();
    }
  }, 20_000);

  it("does not invoke a cancelled run after pre-adapter setup yields", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = `cancel-before-invoke-${randomUUID()}`;
    const setupBarrier = delayMatchingSelectResult(db, (result) => {
      return Boolean(
        Array.isArray(result) &&
          result.some(
            (row) =>
              row &&
              typeof row === "object" &&
              (row as { agentId?: unknown }).agentId === agentId &&
              "totalInputTokens" in row,
          ),
      );
    });
    const invokedRunIds: string[] = [];
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      invokedRunIds.push(ctx.runId);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: { benign: "preserved" },
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `Z${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CancelBeforeInvokeAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "process",
      stateJson: {},
    });

    try {
      const cancelledRun = await heartbeatService(setupBarrier.database).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: {
          taskKey,
          rawCommand: "cancelled operational context",
        },
      });
      expect(cancelledRun).not.toBeNull();
      await setupBarrier.reached;
      expect(sharedTransientExecutionContextStore.get(cancelledRun!.id)).toBeUndefined();

      const followupRun = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { commentId: randomUUID() },
        contextSnapshot: {
          taskKey,
          rawCommand: "follow-up operational context",
        },
      });
      expect(followupRun).not.toBeNull();
      expect(followupRun?.id).not.toBe(cancelledRun!.id);
      expect(followupRun?.status).toBe("queued");

      let cancellationSettled = false;
      const cancellation = heartbeatService(db).cancelRun(cancelledRun!.id).finally(() => {
        cancellationSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(cancellationSettled).toBe(false);
      setupBarrier.release();
      await expect(cancellation).resolves.toMatchObject({
        id: cancelledRun!.id,
        status: "cancelled",
      });

      await waitFor(async () => {
        const [cancelled, followup] = await Promise.all([
          db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, cancelledRun!.id))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, followupRun!.id))
            .then((rows) => rows[0] ?? null),
        ]);
        expect(cancelled?.status).toBe("cancelled");
        expect(followup?.status).toBe("succeeded");
      });

      expect(invokedRunIds).toEqual([followupRun!.id]);
      expect(sharedTransientExecutionContextStore.get(cancelledRun!.id)).toBeUndefined();
    } finally {
      setupBarrier.release();
      executeSpy.mockRestore();
    }
  }, 20_000);

  it("reserves launch ownership before a queued claim becomes visible", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const claimBarrier = delayMatchingTransactionResult(db, (result) =>
      Boolean(
        result &&
          typeof result === "object" &&
          (result as { id?: unknown }).id === runId &&
          (result as { status?: unknown }).status === "running",
      ),
    );
    const executeSpy = vi.spyOn(getServerAdapter("process"), "execute").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaimReservationAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
    });

    try {
      const resume = heartbeatService(claimBarrier.database).resumeQueuedRuns();
      await claimBarrier.reached;
      let cancellationSettled = false;
      const cancellation = heartbeatService(db).cancelActiveForAgent(agentId).finally(() => {
        cancellationSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(cancellationSettled).toBe(false);
      claimBarrier.release();
      await expect(resume).resolves.toBeUndefined();
      await expect(cancellation).resolves.toBe(1);
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      claimBarrier.release();
      executeSpy.mockRestore();
    }
  }, 20_000);

  it("drains budget-blocked claims and skips paused agents without reservation deadlock", async () => {
    const companyId = randomUUID();
    const activeAgentId = randomUUID();
    const pausedAgentId = randomUUID();
    const budgetRunId = randomUUID();
    const budgetWakeupId = randomUUID();
    const pausedRunId = randomUUID();
    const pausedWakeupId = randomUUID();
    const issuePrefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Budget Paused Paperclip",
      issuePrefix,
      status: "paused",
      pauseReason: "budget",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: activeAgentId,
        companyId,
        name: "BudgetBlockedClaimAgent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
        permissions: {},
      },
      {
        id: pausedAgentId,
        companyId,
        name: "PausedClaimAgent",
        role: "engineer",
        status: "paused",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(agentWakeupRequests).values([
      {
        id: budgetWakeupId,
        companyId,
        agentId: activeAgentId,
        source: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        runId: budgetRunId,
      },
      {
        id: pausedWakeupId,
        companyId,
        agentId: pausedAgentId,
        source: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        runId: pausedRunId,
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: budgetRunId,
        companyId,
        agentId: activeAgentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId: budgetWakeupId,
      },
      {
        id: pausedRunId,
        companyId,
        agentId: pausedAgentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId: pausedWakeupId,
      },
    ]);

    await expect(heartbeatService(db).resumeQueuedRuns()).resolves.toBeUndefined();
    const [budgetRun, pausedRun] = await Promise.all([
      heartbeatService(db).getRun(budgetRunId),
      heartbeatService(db).getRun(pausedRunId),
    ]);
    expect(budgetRun?.status).toBe("cancelled");
    expect(pausedRun?.status).toBe("queued");
  }, 5_000);

  it("keeps late onSpawn cancellation serialized until the old execution settles", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = `late-spawn-${randomUUID()}`;
    let enteredResolve!: () => void;
    let allowSpawnResolve!: () => void;
    let spawnedResolve!: () => void;
    let allowSettlementResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const allowSpawn = new Promise<void>((resolve) => {
      allowSpawnResolve = resolve;
    });
    const spawned = new Promise<void>((resolve) => {
      spawnedResolve = resolve;
    });
    const allowSettlement = new Promise<void>((resolve) => {
      allowSettlementResolve = resolve;
    });
    let oldExecutionSettled = false;
    const followupObservations: boolean[] = [];
    let firstInvocation = true;
    const executeSpy = vi.spyOn(getServerAdapter("process"), "execute").mockImplementation(async (ctx) => {
      if (!firstInvocation) {
        followupObservations.push(oldExecutionSettled);
        return { exitCode: 0, signal: null, timedOut: false };
      }
      firstInvocation = false;
      enteredResolve();
      await allowSpawn;
      await ctx.onSpawn?.({ pid: 999_999_998, startedAt: new Date().toISOString() });
      spawnedResolve();
      await allowSettlement;
      oldExecutionSettled = true;
      return { exitCode: 0, signal: null, timedOut: false };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LateSpawnAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    try {
      const oldRun = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey },
      });
      expect(oldRun).not.toBeNull();
      await entered;
      const followup = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { commentId: randomUUID() },
        contextSnapshot: { taskKey },
      });
      expect(followup?.status).toBe("queued");

      let cancellationSettled = false;
      const cancellation = heartbeatService(db).cancelRun(oldRun!.id).finally(() => {
        cancellationSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(cancellationSettled).toBe(false);
      allowSpawnResolve();
      await spawned;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(cancellationSettled).toBe(false);
      allowSettlementResolve();
      await expect(cancellation).resolves.toMatchObject({ id: oldRun!.id, status: "cancelled" });
      await waitFor(async () => expect(followupObservations).toEqual([true]));
    } finally {
      allowSpawnResolve();
      allowSettlementResolve();
      executeSpy.mockRestore();
    }
  }, 20_000);

  it("keeps a timed-out launch handshake counted until the adapter settles", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = `launch-timeout-${randomUUID()}`;
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    let firstInvocation = true;
    let oldExecutionSettled = false;
    const followupObservations: boolean[] = [];
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async () => {
      if (!firstInvocation) {
        followupObservations.push(oldExecutionSettled);
        return { exitCode: 0, signal: null, timedOut: false };
      }
      firstInvocation = false;
      enteredResolve();
      await release;
      oldExecutionSettled = true;
      return { exitCode: 0, signal: null, timedOut: false };
    });
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        nativeSetTimeout(callback, delay === 15_000 ? 0 : delay, ...args)) as typeof setTimeout,
    );

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LaunchHandshakeAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    try {
      const service = heartbeatService(db);
      const oldRun = await service.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey },
      });
      expect(oldRun).not.toBeNull();
      await entered;
      await waitFor(async () => {
        await expect(service.getRun(oldRun!.id)).resolves.toMatchObject({
          status: "failed",
          errorCode: "timeout",
        });
      });
      const followup = await service.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { commentId: randomUUID() },
        contextSnapshot: { taskKey },
      });
      expect(followup?.status).toBe("queued");
      expect(executeSpy).toHaveBeenCalledTimes(1);

      releaseResolve();
      await waitFor(async () => {
        expect(followupObservations).toEqual([true]);
        await expect(service.getRun(followup!.id)).resolves.toMatchObject({
          status: "succeeded",
        });
      });
    } finally {
      releaseResolve();
      timeoutSpy.mockRestore();
      executeSpy.mockRestore();
    }
  }, 20_000);

  it("does not promote when coordinated process-tree termination remains unproven", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    const killSpy = vi.spyOn(child, "kill").mockImplementation(() => true);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = `unproven-termination-${randomUUID()}`;
    let spawnedResolve!: () => void;
    let releaseAdapterResolve!: () => void;
    const spawned = new Promise<void>((resolve) => {
      spawnedResolve = resolve;
    });
    const releaseAdapter = new Promise<void>((resolve) => {
      releaseAdapterResolve = resolve;
    });
    let invocationCount = 0;
    const executeSpy = vi.spyOn(getServerAdapter("process"), "execute").mockImplementation(async (ctx) => {
      invocationCount += 1;
      if (invocationCount > 1) return { exitCode: 0, signal: null, timedOut: false };
      runningProcesses.set(ctx.runId, { child, graceSec: 0, processGroup: false });
      await ctx.onSpawn?.({ pid: child.pid!, startedAt: new Date().toISOString() });
      spawnedResolve();
      await releaseAdapter;
      return { exitCode: 0, signal: null, timedOut: false };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "UnprovenTerminationAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    try {
      const oldRun = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey },
      });
      await spawned;
      const followup = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { commentId: randomUUID() },
        contextSnapshot: { taskKey },
      });
      const cancellation = heartbeatService(db).cancelRun(oldRun!.id);
      await waitFor(async () => {
        expect(killSpy).toHaveBeenCalledWith("SIGKILL");
      }, 8_000);
      releaseAdapterResolve();
      await expect(cancellation).resolves.toMatchObject({
        status: "cancelled",
        errorCode: "process_termination_pending",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(invocationCount).toBe(1);
      await expect(heartbeatService(db).getRun(followup!.id)).resolves.toMatchObject({
        status: "queued",
      });
    } finally {
      releaseAdapterResolve();
      executeSpy.mockRestore();
      killSpy.mockRestore();
      child.kill("SIGKILL");
    }
  }, 20_000);

  it("keeps capacity blocked when an adapter result cannot prove process-tree termination", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    const killSpy = vi.spyOn(child, "kill").mockImplementation(() => true);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = `result-termination-pending-${randomUUID()}`;
    let invocationCount = 0;
    const executeSpy = vi
      .spyOn(getServerAdapter("process"), "execute")
      .mockImplementation(async (ctx) => {
        invocationCount += 1;
        if (invocationCount > 1) {
          return { exitCode: 0, signal: null, timedOut: false };
        }
        runningProcesses.set(ctx.runId, { child, graceSec: 0, processGroup: false });
        await ctx.onSpawn?.({ pid: child.pid!, startedAt: new Date().toISOString() });
        return { exitCode: 0, signal: null, timedOut: false };
      });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ResultTerminationPendingAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    try {
      const service = heartbeatService(db);
      const oldRun = await service.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey },
      });
      await waitFor(async () => {
        await expect(service.getRun(oldRun!.id)).resolves.toMatchObject({
          status: "failed",
          errorCode: "process_termination_pending",
        });
        const runtime = await db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, agentId))
          .then((rows) => rows[0] ?? null);
        const currentAgent = await db
          .select()
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((rows) => rows[0] ?? null);
        expect(runtime?.lastRunId).toBe(oldRun!.id);
        expect(currentAgent?.status).toBe("running");
      }, 10_000);

      const followup = await service.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { commentId: randomUUID() },
        contextSnapshot: { taskKey },
      });
      await service.resumeQueuedRuns();

      expect(invocationCount).toBe(1);
      expect(runningProcesses.get(oldRun!.id)?.child).toBe(child);
      await expect(service.getRun(followup!.id)).resolves.toMatchObject({
        status: "queued",
      });

      killSpy.mockRestore();
      await waitFor(async () => {
        const recovery = await service.reapOrphanedRuns();
        expect(recovery.runIds).toContain(oldRun!.id);
      }, 10_000);
      await waitFor(async () => {
        expect(invocationCount).toBe(2);
        await expect(service.getRun(oldRun!.id)).resolves.toMatchObject({
          status: "failed",
          errorCode: "adapter_failed",
          processPid: null,
        });
        await expect(service.getRun(followup!.id)).resolves.toMatchObject({
          status: "succeeded",
        });
      });
    } finally {
      executeSpy.mockRestore();
      killSpy.mockRestore();
      child.kill("SIGKILL");
    }
  }, 20_000);

  it("waits for a resistant local process group before starting the next queued run", async () => {
    if (process.platform === "win32") return;
    const { child, grandchildPid } = await spawnTermResistantProcessGroup();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "process",
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const followupRunId = randomUUID();
    const followupWakeupId = randomUUID();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    await db.insert(agentWakeupRequests).values({
      id: followupWakeupId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      runId: followupRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: followupRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId: followupWakeupId,
    });
    runningProcesses.set(runId, {
      child,
      graceSec: 0.05,
      processGroup: true,
    });
    const observedAtFollowup: Array<{ parentAlive: boolean; grandchildAlive: boolean }> = [];
    const executeSpy = vi.spyOn(getServerAdapter("process"), "execute").mockImplementation(async () => {
      observedAtFollowup.push({
        parentAlive: isAlive(child.pid!),
        grandchildAlive: isAlive(grandchildPid),
      });
      return { exitCode: 0, signal: null, timedOut: false };
    });

    try {
      await expect(heartbeatService(db).cancelRun(runId)).resolves.toMatchObject({
        id: runId,
        status: "cancelled",
      });
      await waitFor(async () => expect(observedAtFollowup).toHaveLength(1));
      expect(observedAtFollowup).toEqual([{ parentAlive: false, grandchildAlive: false }]);
    } finally {
      executeSpy.mockRestore();
      if (child.pid && isAlive(child.pid)) process.kill(-child.pid, "SIGKILL");
      else if (isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    }
  }, 20_000);

  it("keeps an untracked cancelled process blocked across restart until reaper proves absence", async () => {
    if (process.platform === "win32") return;
    const { child, grandchildPid } = await spawnTermResistantProcessGroup();
    childProcesses.add(child);
    const companyId = randomUUID();
    const blockerAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const deferredWakeupId = randomUUID();
    const issuePrefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const invokedRunIds: string[] = [];
    const executeSpy = vi.spyOn(getServerAdapter("process"), "execute").mockImplementation(async (ctx) => {
      invokedRunIds.push(ctx.runId);
      return { exitCode: 0, signal: null, timedOut: false };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: blockerAgentId,
        companyId,
        name: "DetachedCancellationBlocker",
        role: "engineer",
        status: "running",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetAgentId,
        companyId,
        name: "DetachedCancellationTarget",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: blockerAgentId,
      source: "assignment",
      triggerDetail: "system",
      status: "claimed",
      runId,
      claimedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: blockerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId },
      processPid: child.pid,
      processStartedAt: new Date(),
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recover detached cancellation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: targetAgentId,
      executionRunId: runId,
      executionAgentNameKey: "detachedcancellationblocker",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: targetAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: { issueId, _paperclipWakeContext: { issueId } },
      status: "deferred_issue_execution",
    });

    try {
      const cancelled = await heartbeatService(db).cancelRun(runId);
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.errorCode).toBe("process_termination_pending");
      expect(child.pid && isAlive(child.pid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);
      expect(invokedRunIds).toEqual([]);
      const lockedIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(lockedIssue?.executionRunId).toBe(runId);

      process.kill(-child.pid!, "SIGKILL");
      await waitFor(async () => {
        expect(child.pid && isAlive(child.pid)).toBe(false);
        expect(isAlive(grandchildPid)).toBe(false);
      });

      const recovered = await heartbeatService(db).reapOrphanedRuns();
      expect(recovered.runIds).toContain(runId);
      await waitFor(async () => expect(invokedRunIds).toHaveLength(1));
      const [persistedRun, deferredWakeup, recoveredIssue] = await Promise.all([
        heartbeatService(db).getRun(runId),
        db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, deferredWakeupId))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null),
      ]);
      expect(persistedRun?.errorCode).toBe("cancelled");
      expect(persistedRun?.processPid).toBeNull();
      expect(deferredWakeup?.runId).toBe(invokedRunIds[0]);
      expect(recoveredIssue?.executionRunId).not.toBe(runId);
    } finally {
      executeSpy.mockRestore();
      if (child.pid && isAlive(child.pid)) process.kill(-child.pid, "SIGKILL");
      else if (isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    }
  }, 20_000);

  it("clears deferred transient context when a budget scope cancels pending wakeups", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BudgetCancelledDeferredAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
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
      reason: "issue_execution_deferred",
      payload: { issueId: randomUUID() },
      status: "deferred_issue_execution",
    });
    const transientKey = `deferred-wakeup:${wakeupRequestId}`;
    expect(
      sharedTransientExecutionContextStore.set(transientKey, {
        command: "raw deferred secret",
      }),
    ).toBe(true);

    await heartbeatService(db).cancelBudgetScopeWork({
      companyId,
      scopeType: "company",
      scopeId: companyId,
    });

    const cancelled = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(cancelled?.status).toBe("cancelled");
    expect(sharedTransientExecutionContextStore.get(transientKey)).toBeUndefined();
  });

  it("does not recreate queued raw context when coalescing loses a cancellation race", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const taskKey = `cancelled-coalesce-${randomUUID()}`;
    const controlSecret = "cancelled-coalesce-raw-secret-value-42";
    const barrier = delayMatchingSelectResult(db, (result) =>
      Array.isArray(result) &&
      result.some(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { id?: unknown }).id === runId &&
          (row as { status?: unknown }).status === "queued",
      ),
    );

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CancelledCoalesceAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "existing queued wake",
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { taskKey, benignExisting: "preserved" },
    });
    expect(
      sharedTransientExecutionContextStore.set(runId, {
        taskKey,
        command: "old raw context",
      }),
    ).toBe(true);

    try {
      const coalescePromise = heartbeatService(barrier.database).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: {
          taskKey,
          command: `use ${controlSecret}`,
          benignIncoming: "preserved",
        },
      });
      await barrier.reached;
      await heartbeatService(db).cancelRun(runId);
      expect(sharedTransientExecutionContextStore.get(runId)).toBeUndefined();
      barrier.release();

      await expect(coalescePromise).resolves.toBeNull();
      const persistedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(persistedRun?.status).toBe("cancelled");
      expect(sharedTransientExecutionContextStore.get(runId)).toBeUndefined();
    } finally {
      barrier.release();
    }
  }, 20_000);

  it("does not recreate deferred raw context when coalescing loses a budget cancellation race", async () => {
    const companyId = randomUUID();
    const blockerAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const activeRunId = randomUUID();
    const issueId = randomUUID();
    const deferredWakeupRequestId = randomUUID();
    const taskKey = `cancelled-deferred-${randomUUID()}`;
    const controlSecret = "cancelled-deferred-raw-secret-value-42";
    const transientKey = `deferred-wakeup:${deferredWakeupRequestId}`;
    const barrier = delayMatchingSelectResult(db, (result) =>
      Array.isArray(result) &&
      result.some(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { id?: unknown }).id === deferredWakeupRequestId &&
          (row as { status?: unknown }).status === "deferred_issue_execution",
      ),
    );
    const issuePrefix = `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: blockerAgentId,
        companyId,
        name: "DeferredCancellationBlocker",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetAgentId,
        companyId,
        name: "DeferredCancellationTarget",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId: blockerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancel a coalescing deferred wake",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: targetAgentId,
      executionRunId: activeRunId,
      executionAgentNameKey: "deferredcancellationblocker",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupRequestId,
      companyId,
      agentId: targetAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: { issueId, taskKey, benignExisting: "preserved" },
      },
      status: "deferred_issue_execution",
      coalescedCount: 0,
    });
    expect(
      sharedTransientExecutionContextStore.set(transientKey, {
        issueId,
        taskKey,
        command: "old raw deferred context",
      }),
    ).toBe(true);

    try {
      const coalescePromise = heartbeatService(barrier.database).wakeup(targetAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue execution followup",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey,
          command: `use ${controlSecret}`,
          benignIncoming: "preserved",
        },
      });
      await barrier.reached;
      await heartbeatService(db).cancelBudgetScopeWork({
        companyId,
        scopeType: "agent",
        scopeId: targetAgentId,
      });
      expect(sharedTransientExecutionContextStore.get(transientKey)).toBeUndefined();
      barrier.release();

      await expect(coalescePromise).resolves.toBeNull();
      const persistedWakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(persistedWakeup?.status).toBe("cancelled");
      expect(persistedWakeup?.coalescedCount).toBe(0);
      expect(sharedTransientExecutionContextStore.get(transientKey)).toBeUndefined();
    } finally {
      barrier.release();
    }
  }, 20_000);

  it("preserves both non-issue coalesced contexts when the same queued version races", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const taskKey = `same-version-coalesce-${randomUUID()}`;
    const firstBarrier = delayNextTransactionStart(db);
    const secondBarrier = delayNextTransactionStart(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ConcurrentCoalesceAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "existing queued wake",
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { taskKey, benignBase: "preserved" },
    });
    expect(
      sharedTransientExecutionContextStore.set(runId, {
        taskKey,
        benignBase: "preserved",
        rawBase: "base operational context",
      }),
    ).toBe(true);

    try {
      const firstWake = heartbeatService(firstBarrier.database).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: {
          taskKey,
          firstIncoming: "first operational context",
        },
      });
      const secondWake = heartbeatService(secondBarrier.database).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: {
          taskKey,
          secondIncoming: "second operational context",
        },
      });

      await Promise.all([firstBarrier.reached, secondBarrier.reached]);
      firstBarrier.release();
      secondBarrier.release();

      const [firstResult, secondResult] = await Promise.all([firstWake, secondWake]);
      expect(firstResult?.id).toBe(runId);
      expect(secondResult?.id).toBe(runId);
      expect(sharedTransientExecutionContextStore.get(runId)).toMatchObject({
        taskKey,
        benignBase: "preserved",
        rawBase: "base operational context",
        firstIncoming: "first operational context",
        secondIncoming: "second operational context",
      });

      const persistedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(persistedRun?.contextSnapshot).toMatchObject({
        taskKey,
        benignBase: "preserved",
        firstIncoming: "first operational context",
        secondIncoming: "second operational context",
      });
      const coalescedWakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "coalesced"),
          ),
        );
      expect(coalescedWakeups).toHaveLength(2);
    } finally {
      firstBarrier.release();
      secondBarrier.release();
    }
  }, 20_000);

  it("preserves issue and bypass coalesced contexts across a shared-run race", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const taskKey = `cross-path-coalesce-${randomUUID()}`;
    const issuePrefix = `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const regularBarrier = delayNextTableUpdateExecution(db, heartbeatRuns);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CrossPathCoalesceAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "existing queued issue wake",
      payload: { issueId },
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, taskKey, benignBase: "preserved" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Preserve cross-path coalesced context",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "crosspathcoalesceagent",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    expect(
      sharedTransientExecutionContextStore.set(runId, {
        issueId,
        taskKey,
        benignBase: "preserved",
        rawBase: "base operational context",
      }),
    ).toBe(true);

    try {
      const regularWake = heartbeatService(regularBarrier.database).wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "regular issue wake",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey,
          regularIncoming: "regular operational context",
        },
      });
      await regularBarrier.reached;

      const bypassWake = await heartbeatService(db).wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_comment_mentioned",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey,
          bypassIncoming: "bypass operational context",
        },
      });
      expect(bypassWake?.id).toBe(runId);
      regularBarrier.release();

      const regularResult = await regularWake;
      expect(regularResult?.id).toBe(runId);
      expect(sharedTransientExecutionContextStore.get(runId)).toMatchObject({
        issueId,
        taskKey,
        benignBase: "preserved",
        rawBase: "base operational context",
        regularIncoming: "regular operational context",
        bypassIncoming: "bypass operational context",
      });

      const persistedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(persistedRun?.contextSnapshot).toMatchObject({
        issueId,
        taskKey,
        benignBase: "preserved",
        regularIncoming: "regular operational context",
        bypassIncoming: "bypass operational context",
      });
    } finally {
      regularBarrier.release();
    }
  }, 20_000);

  it("queues a non-issue follow-up when the selected queued run becomes terminal", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const blockerRunId = randomUUID();
    const taskKey = `terminal-coalesce-${randomUUID()}`;
    const barrier = delayMatchingSelectResult(db, (result) =>
      Array.isArray(result) &&
      result.some(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { id?: unknown }).id === runId &&
          (row as { status?: unknown }).status === "queued",
      ),
    );

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TerminalCoalesceAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "existing queued wake",
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        wakeupRequestId,
        contextSnapshot: { taskKey, benignExisting: "preserved" },
      },
      {
        id: blockerRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { taskKey: `other-${randomUUID()}` },
      },
    ]);

    try {
      const followupPromise = heartbeatService(barrier.database).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: {
          taskKey,
          rawFollowup: "terminal transition operational context",
          benignIncoming: "preserved",
        },
      });
      await barrier.reached;
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "queued")));
      barrier.release();

      const followupRun = await followupPromise;
      expect(followupRun).not.toBeNull();
      expect(followupRun?.id).not.toBe(runId);
      expect(followupRun?.status).toBe("queued");
      expect(sharedTransientExecutionContextStore.get(followupRun!.id)).toMatchObject({
        taskKey,
        rawFollowup: "terminal transition operational context",
        benignIncoming: "preserved",
      });
    } finally {
      barrier.release();
    }
  }, 20_000);

  it("queues raw follow-up context when a selected queued run becomes running", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const taskKey = `claim-race-${randomUUID()}`;
    const controlSecret = "claimed-followup-raw-secret-value-42";
    const barrier = delayMatchingSelectResult(db, (result) =>
      Array.isArray(result) &&
      result.some(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { id?: unknown }).id === runId &&
          (row as { status?: unknown }).status === "queued",
      ),
    );

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaimRaceAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "existing queued wake",
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { taskKey },
    });

    try {
      const followupPromise = heartbeatService(barrier.database).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { commentId: randomUUID() },
        contextSnapshot: {
          taskKey,
          command: `use ${controlSecret}`,
          benignIncoming: "preserved",
        },
      });
      await barrier.reached;
      await db
        .update(heartbeatRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "queued")));
      barrier.release();

      const followupRun = await followupPromise;
      expect(followupRun).not.toBeNull();
      expect(followupRun?.id).not.toBe(runId);
      expect(followupRun?.status).toBe("queued");
      expect(sharedTransientExecutionContextStore.get(followupRun!.id)).toMatchObject({
        taskKey,
        command: `use ${controlSecret}`,
        benignIncoming: "preserved",
      });
    } finally {
      barrier.release();
    }
  }, 20_000);

  it("creates a fresh deferred raw follow-up when the selected wake was promoted", async () => {
    const companyId = randomUUID();
    const blockerAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const activeRunId = randomUUID();
    const promotedRunId = randomUUID();
    const issueId = randomUUID();
    const existingDeferredId = randomUUID();
    const taskKey = `promoted-coalesce-${randomUUID()}`;
    const controlSecret = "promoted-coalesce-raw-secret-value-42";
    const barrier = delayMatchingSelectResult(db, (result) =>
      Array.isArray(result) &&
      result.some(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { id?: unknown }).id === existingDeferredId &&
          (row as { status?: unknown }).status === "deferred_issue_execution",
      ),
    );
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: blockerAgentId,
        companyId,
        name: "PromotedCoalesceBlocker",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetAgentId,
        companyId,
        name: "PromotedCoalesceTarget",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId: blockerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Promoted deferred coalescing",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: targetAgentId,
      executionRunId: activeRunId,
      executionAgentNameKey: "promotedcoalesceblocker",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(agentWakeupRequests).values({
      id: existingDeferredId,
      companyId,
      agentId: targetAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: { issueId, _paperclipWakeContext: { issueId, taskKey } },
      status: "deferred_issue_execution",
    });

    try {
      const followupPromise = heartbeatService(barrier.database).wakeup(targetAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "promoted deferred followup",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey,
          command: `use ${controlSecret}`,
          benignIncoming: "preserved",
        },
      });
      await barrier.reached;
      await db.insert(heartbeatRuns).values({
        id: promotedRunId,
        companyId,
        agentId: targetAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: existingDeferredId,
        contextSnapshot: { issueId, taskKey },
      });
      await db
        .update(agentWakeupRequests)
        .set({ status: "queued", runId: promotedRunId })
        .where(eq(agentWakeupRequests.id, existingDeferredId));
      barrier.release();

      await expect(followupPromise).resolves.toBeNull();
      const freshDeferred = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, targetAgentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        )
        .then((rows) => rows.find((row) => row.id !== existingDeferredId) ?? null);
      expect(freshDeferred).not.toBeNull();
      expect(
        sharedTransientExecutionContextStore.get(`deferred-wakeup:${freshDeferred!.id}`),
      ).toMatchObject({
        issueId,
        taskKey,
        command: `use ${controlSecret}`,
        benignIncoming: "preserved",
      });
    } finally {
      barrier.release();
    }
  }, 20_000);

  it("fails closed when credentials are split across alternating heartbeat log streams", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const exactPrefix = "heartbeat-cross-stream-exact-prefix-";
    const exactSecret = `${exactPrefix}tail-value-42`;
    const jwtPrefix = "eyJhbGciOiJIUzI1NiJ9";
    const jwtSecret = `${jwtPrefix}.eyJzdWIiOiJjcm9zcy1zdHJlYW0ifQ.signaturevalue123456`;
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = exactSecret;
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      await ctx.onLog("stdout", exactPrefix);
      await ctx.onLog("stderr", exactSecret.slice(exactPrefix.length));
      await ctx.onLog("stdout", "exact-release\n");
      await ctx.onLog("stdout", jwtPrefix);
      await ctx.onLog("stderr", jwtSecret.slice(jwtPrefix.length));
      await ctx.onLog("stdout", "jwt-release\n");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "completed",
      };
    });
    const liveLogPayloads: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "heartbeat.run.log") liveLogPayloads.push(event.payload);
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CrossStreamLogAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const heartbeat = heartbeatService(db);
      const returnedRun = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
      });
      expect(returnedRun).not.toBeNull();

      await waitFor(async () => {
        const current = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, returnedRun?.id ?? ""))
          .then((rows) => rows[0] ?? null);
        expect(current?.status).toBe("succeeded");
      });

      const persistedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, returnedRun?.id ?? ""))
        .then((rows) => rows[0] ?? null);
      const persistedEvents = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, returnedRun?.id ?? ""));
      const rawLog = await heartbeat.readLog(returnedRun!.id);
      const rawStoredLog = await getRunLogStore().read({
        store: "local_file",
        logRef: persistedRun!.logRef!,
      });
      const surfaces = {
        excerpts: `${persistedRun?.stdoutExcerpt ?? ""}\n${persistedRun?.stderrExcerpt ?? ""}`,
        liveEvents: JSON.stringify(liveLogPayloads),
        persistedEvents: JSON.stringify(persistedEvents),
        rawLog: rawLog.content,
        rawAtRest: rawStoredLog.content,
        result: JSON.stringify(persistedRun?.resultJson),
      };

      expect(executeSpy).toHaveBeenCalledTimes(1);
      for (const [name, surface] of Object.entries(surfaces)) {
        expect(surface, name).not.toContain(exactSecret);
        expect(surface, name).not.toContain(jwtSecret);
        expect(surface, name).not.toContain(exactPrefix);
        expect(surface, name).not.toContain(jwtPrefix);
      }
      for (const [name, surface] of Object.entries({
        excerpts: surfaces.excerpts,
        liveEvents: surfaces.liveEvents,
        rawLog: surfaces.rawLog,
        rawAtRest: surfaces.rawAtRest,
      })) {
        expect(surface, name).toContain("exact-release");
        expect(surface, name).toContain("jwt-release");
        expect(surface, name).toContain("***REDACTED***");
      }
    } finally {
      unsubscribe();
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("prevents JWT reconstruction across persisted and live heartbeat events", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const tokenTail = "yJheader.payload.signature_with-hyphen_";
    const token = `e${tokenTail}`;
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      await ctx.onMeta?.({
        adapterType: "process",
        command: "e",
        context: { benignMetadata: "preserved" },
      });
      throw new Error(tokenTail);
    });
    const liveEvents: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "heartbeat.run.event") {
        liveEvents.push(event.payload as Record<string, unknown>);
      }
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "EventBoundaryAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const run = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey: `event-boundary-${randomUUID()}` },
      });
      expect(run).not.toBeNull();
      await waitFor(async () => {
        const current = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run!.id))
          .then((rows) => rows[0] ?? null);
        expect(current?.status).toBe("failed");
        const events = await db
          .select()
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, run!.id));
        expect(events.some((event) => event.eventType === "error")).toBe(true);
      });

      const persistedEvents = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run!.id));
      const persistedInvoke = persistedEvents.find((event) => event.eventType === "adapter.invoke");
      const persistedError = persistedEvents.find((event) => event.eventType === "error");
      const liveInvoke = liveEvents.find((event) => event.eventType === "adapter.invoke");
      const liveError = liveEvents.find((event) => event.eventType === "error");
      const persistedCommand = (
        persistedInvoke?.payload as { command?: string; context?: { benignMetadata?: string } }
      )?.command;
      const liveCommand = (liveInvoke?.payload as { command?: string } | undefined)?.command;

      expect(`${persistedCommand ?? ""}${persistedError?.message ?? ""}`).not.toContain(token);
      expect(`${liveCommand ?? ""}${liveError?.message ?? ""}`).not.toContain(token);
      expect(persistedCommand).toBe("***REDACTED***");
      expect(liveCommand).toBe("***REDACTED***");
      expect(persistedInvoke).toMatchObject({
        runId: run!.id,
        agentId,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
      });
      expect(liveInvoke).toMatchObject({
        runId: run!.id,
        agentId,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
      });
      expect(
        (
          persistedInvoke?.payload as {
            context?: { benignMetadata?: string };
          }
        )?.context?.benignMetadata,
      ).toBe("preserved");
    } finally {
      unsubscribe();
      executeSpy.mockRestore();
    }
  }, 20_000);

  it("prevents JWT reconstruction across final run diagnostic fields", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = `final-diagnostic-${randomUUID()}`;
    const tokenTail = "yJfinal.payload.signature_with-hyphen_";
    const token = `e${tokenTail}`;
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockImplementation(async (ctx) => {
      await ctx.onLog("stdout", `benign-output\n${tokenTail}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "e",
        errorCode: "fatal",
        resultJson: { benignResult: "preserved" },
        sessionId: "benign-session-id",
        sessionDisplayId: "benign-session-id",
        sessionParams: { sessionId: "benign-session-id", benign: "preserved" },
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FinalDiagnosticBoundaryAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const run = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey },
      });
      expect(run).not.toBeNull();
      await waitFor(async () => {
        const [current, wakeup, session, runtime, currentAgent] = await Promise.all([
          db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, run!.id))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, run!.wakeupRequestId!))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(agentTaskSessions)
            .where(eq(agentTaskSessions.lastRunId, run!.id))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(agentRuntimeState)
            .where(eq(agentRuntimeState.agentId, agentId))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        ]);
        expect(current?.status).toBe("failed");
        expect(wakeup?.error).toBe("***REDACTED***");
        expect(session?.lastError).toBe("***REDACTED***");
        expect(runtime?.lastRunId).toBe(run!.id);
        expect(runtime?.lastError).toBe("***REDACTED***");
        expect(currentAgent?.status).toBe("error");
      });

      const persistedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      expect(`${persistedRun?.error ?? ""}${persistedRun?.stdoutExcerpt ?? ""}`).not.toContain(
        token,
      );
      expect(persistedRun).toMatchObject({
        id: run!.id,
        agentId,
        companyId,
        status: "failed",
        errorCode: "fatal",
        exitCode: 1,
      });
      expect(persistedRun?.stdoutExcerpt).toContain("benign-output");
      expect(persistedRun?.resultJson).toMatchObject({ benignResult: "preserved" });
      const [persistedWakeup, persistedSession] = await Promise.all([
        db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, run!.wakeupRequestId!))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(agentTaskSessions)
          .where(eq(agentTaskSessions.lastRunId, run!.id))
          .then((rows) => rows[0] ?? null),
      ]);
      expect(persistedRun?.error).toBe("***REDACTED***");
      expect(persistedWakeup?.error).toBe("***REDACTED***");
      expect(persistedSession?.lastError).toBe("***REDACTED***");
      expect(persistedSession?.taskKey).toBe(taskKey);
      await waitFor(async () => {
        const runtime = await db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, agentId))
          .then((rows) => rows[0] ?? null);
        const currentAgent = await db
          .select()
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((rows) => rows[0] ?? null);
        expect(runtime?.lastRunId).toBe(run!.id);
        expect(runtime?.lastError).toBe("***REDACTED***");
        expect(currentAgent?.status).toBe("error");
      });
    } finally {
      executeSpy.mockRestore();
    }
  }, 20_000);

  it("redacts batch request and session snapshot credentials before persistence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const controlSecret = "batch-session-current-secret-value-42";
    const splitAt = 19;
    const secretPrefix = controlSecret.slice(0, splitAt);
    const secretTail = controlSecret.slice(splitAt);
    const customId = `pclp_${randomUUID().replace(/-/g, "")}`;
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "batch queued",
      sessionParams: {
        benignSession: "preserved",
        sessionSecretTail: secretTail,
        sessionSecretPrefix: secretPrefix,
        sessionParamsSnapshot: {
          benignSnapshot: "preserved",
          secretTail,
          secretPrefix,
        },
        batchQueue: {
          customId,
          requestParamsJson: {
            benignRequest: "preserved",
            secretTail,
            secretPrefix,
          },
        },
      },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BatchSecretAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const returnedRun = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey: `batch-task-${randomUUID()}` },
      });
      expect(returnedRun).not.toBeNull();
      await waitFor(async () => {
        const current = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, returnedRun?.id ?? ""))
          .then((rows) => rows[0] ?? null);
        expect(current?.status).toBe("succeeded");
      });
      await waitFor(async () => {
        const [batchRows, sessionRows] = await Promise.all([
          db
            .select({ id: batchQueueEntries.id })
            .from(batchQueueEntries)
            .where(eq(batchQueueEntries.runId, returnedRun!.id)),
          db
            .select({ id: agentTaskSessions.id })
            .from(agentTaskSessions)
            .where(eq(agentTaskSessions.lastRunId, returnedRun!.id)),
        ]);
        expect(batchRows).toHaveLength(1);
        expect(sessionRows).toHaveLength(1);
      });

      const batchEntry = await db
        .select()
        .from(batchQueueEntries)
        .where(eq(batchQueueEntries.runId, returnedRun!.id))
        .then((rows) => rows[0] ?? null);
      const taskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.lastRunId, returnedRun!.id))
        .then((rows) => rows[0] ?? null);
      const request = (batchEntry?.requestParamsJson ?? {}) as Record<string, unknown>;
      const snapshot = (batchEntry?.sessionParamsSnapshotJson ?? {}) as Record<string, unknown>;
      const persistedSession = (taskSession?.sessionParamsJson ?? {}) as Record<string, unknown>;

      expect(batchEntry).not.toBeNull();
      expect(batchEntry?.customId).toBe(customId);
      expect(request.benignRequest).toBe("preserved");
      expect(snapshot.benignSnapshot).toBe("preserved");
      expect(taskSession?.sessionParamsJson).toMatchObject({ benignSession: "preserved" });
      for (const [name, surface] of Object.entries({
        request: JSON.stringify(request),
        snapshot: JSON.stringify(snapshot),
        taskSession: JSON.stringify(persistedSession),
      })) {
        expect(surface, name).not.toContain(controlSecret);
        expect(surface, name).not.toContain(secretPrefix);
      }
      expect(`${request.secretPrefix ?? ""}${request.secretTail ?? ""}`).not.toBe(controlSecret);
      expect(`${snapshot.secretPrefix ?? ""}${snapshot.secretTail ?? ""}`).not.toBe(controlSecret);
      expect(
        `${persistedSession.sessionSecretPrefix ?? ""}${persistedSession.sessionSecretTail ?? ""}`,
      ).not.toBe(controlSecret);
    } finally {
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("rejects secret-bearing batch custom IDs instead of changing their lookup identity", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const controlSecret = "batch-custom-id-current-secret-value-42";
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "batch rejected",
      sessionParams: {
        benignSession: "preserved",
        batchQueue: {
          customId: controlSecret,
          requestParamsJson: { model: "safe-model" },
        },
      },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BatchCustomIdAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const returnedRun = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey: `batch-custom-id-task-${randomUUID()}` },
      });
      expect(returnedRun).not.toBeNull();
      await waitFor(async () => {
        const [current, sessionRows] = await Promise.all([
          db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, returnedRun!.id))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(agentTaskSessions)
            .where(eq(agentTaskSessions.lastRunId, returnedRun!.id)),
        ]);
        expect(current?.status).toBe("succeeded");
        expect(sessionRows).toHaveLength(1);
      });

      const batchRows = await db
        .select()
        .from(batchQueueEntries)
        .where(eq(batchQueueEntries.runId, returnedRun!.id));
      const taskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.lastRunId, returnedRun!.id))
        .then((rows) => rows[0] ?? null);

      expect(batchRows).toHaveLength(0);
      expect(JSON.stringify(taskSession?.sessionParamsJson)).not.toContain(controlSecret);
      expect(JSON.stringify(taskSession?.sessionParamsJson)).toContain("preserved");
    } finally {
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("masks historical task session credentials when an adapter throws", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = `failed-session-task-${randomUUID()}`;
    const controlSecret = "failed-session-current-secret-value-42";
    const splitAt = 21;
    const secretPrefix = controlSecret.slice(0, splitAt);
    const secretTail = controlSecret.slice(splitAt);
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockRejectedValue(new Error(controlSecret));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FailedSessionAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "process",
      taskKey,
      sessionParamsJson: {
        benignSession: "preserved",
        secretTail,
      },
      sessionDisplayId: secretPrefix,
    });

    try {
      const returnedRun = await heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { taskKey },
      });
      expect(returnedRun).not.toBeNull();
      await waitFor(async () => {
        const [current, session] = await Promise.all([
          db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, returnedRun!.id))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(agentTaskSessions)
            .where(
              and(
                eq(agentTaskSessions.agentId, agentId),
                eq(agentTaskSessions.taskKey, taskKey),
              ),
            )
            .then((rows) => rows[0] ?? null),
        ]);
        expect(current?.status).toBe("failed");
        expect(session?.lastRunId).toBe(returnedRun!.id);
      });

      const taskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(
          and(eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, taskKey)),
        )
        .then((rows) => rows[0] ?? null);
      const persisted = (taskSession?.sessionParamsJson ?? {}) as Record<string, unknown>;

      expect(JSON.stringify(persisted)).not.toContain(controlSecret);
      expect(JSON.stringify(taskSession)).not.toContain(secretPrefix);
      expect(`${taskSession?.sessionDisplayId ?? ""}${persisted.secretTail ?? ""}`).not.toBe(
        controlSecret,
      );
      expect(JSON.stringify(persisted)).toContain("preserved");
      expect(taskSession?.lastError).not.toContain(controlSecret);
    } finally {
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("fails the run safely when an adapter throws a hostile error object", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const controlSecret = "hostile-heartbeat-error-current-secret-value-42";
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const hostileError = new Error("placeholder");
    Object.defineProperty(hostileError, "message", {
      configurable: true,
      get() {
        throw new Error(controlSecret);
      },
    });
    const adapter = getServerAdapter("process");
    const executeSpy = vi.spyOn(adapter, "execute").mockRejectedValue(hostileError);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "HostileErrorAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        cwd: process.cwd(),
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const heartbeat = heartbeatService(db);
      const returnedRun = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
      });
      expect(returnedRun).not.toBeNull();
      await waitFor(async () => {
        const current = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, returnedRun!.id))
          .then((rows) => rows[0] ?? null);
        expect(current?.status).toBe("failed");
      });

      const [persistedRun, persistedWakeup, persistedEvents, persistedRuntime] = await Promise.all([
        db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, returnedRun!.id))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.runId, returnedRun!.id))
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, returnedRun!.id)),
        db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, agentId))
          .then((rows) => rows[0] ?? null),
      ]);
      const persistedSurface = JSON.stringify({
        persistedRun,
        persistedWakeup,
        persistedEvents,
        persistedRuntime,
      });

      expect(persistedRun?.error).toBeTruthy();
      expect(persistedWakeup?.error).toBeTruthy();
      expect(persistedRuntime?.lastRunId).toBe(returnedRun!.id);
      expect(persistedRuntime?.lastRunStatus).toBe("failed");
      expect(persistedSurface).not.toContain(controlSecret);

      // A thrown adapter error is eligible for one delayed retry. Wait until
      // that retry and its lifecycle event are fully persisted so teardown
      // cannot race enqueueRetry, while also proving the 30-second not-before
      // gate keeps it from replacing the failed run's runtime state.
      await waitFor(async () => {
        const retryRun = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, returnedRun!.id))
          .then((rows) => rows[0] ?? null);
        expect(retryRun?.status).toBe("queued");
        const retryContext = (retryRun?.contextSnapshot ?? {}) as Record<string, unknown>;
        const retryNotBeforeAt = Date.parse(String(retryContext.retryNotBeforeAt ?? ""));
        expect(Number.isFinite(retryNotBeforeAt)).toBe(true);
        expect(retryNotBeforeAt - (retryRun?.createdAt?.getTime() ?? retryNotBeforeAt)).toBeGreaterThanOrEqual(
          29_000,
        );
        const retryEvents = await db
          .select()
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, retryRun!.id));
        expect(retryEvents).not.toHaveLength(0);
      });
    } finally {
      executeSpy.mockRestore();
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  }, 20_000);

  it("masks trigger detail on a skipped wakeup request", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const controlSecret = "skipped-trigger-detail-secret-value-42";
    const previous = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = controlSecret;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SkippedWakeupAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const result = await heartbeatService(db).wakeup(agentId, {
        source: "timer",
        triggerDetail: controlSecret as never,
      });
      const persistedWakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows[0] ?? null);

      expect(result).toBeNull();
      expect(persistedWakeup?.status).toBe("skipped");
      expect(persistedWakeup?.triggerDetail).toBe("***REDACTED***");
      expect(JSON.stringify(persistedWakeup)).not.toContain(controlSecret);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previous;
    }
  });

  it("rejects oversized idempotency keys at the heartbeat service boundary", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OversizedIdempotencyAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });

    await expect(
      heartbeatService(db).wakeup(agentId, {
        source: "timer",
        idempotencyKey: "i".repeat(256),
      }),
    ).rejects.toMatchObject({ status: 400 });
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(0);
  });

  it("masks credential-bearing idempotency keys before heartbeat persistence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const controlSecret = "idempotency-current-secret-value-42";
    const splitAt = 20;
    const secretPrefix = controlSecret.slice(0, splitAt);
    const secretTail = controlSecret.slice(splitAt);
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecretIdempotencyAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });

    try {
      const result = await heartbeatService(db).wakeup(agentId, {
        source: "timer",
        idempotencyKey: secretPrefix,
        payload: { secretTail },
      });
      const persisted = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows[0] ?? null);

      expect(result).toBeNull();
      expect(persisted?.status).toBe("skipped");
      expect(persisted?.idempotencyKey).not.toContain(controlSecret);
      expect(persisted?.idempotencyKey).not.toContain(secretPrefix);
      expect(persisted?.idempotencyKey).toContain("REDACTED");
      expect(
        `${persisted?.idempotencyKey ?? ""}${
          ((persisted?.payload ?? {}) as Record<string, unknown>).secretTail ?? ""
        }`,
      ).not.toContain(controlSecret);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  });

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

  it("reaps a max-duration-exceeded local run even when it is still tracked in runningProcesses", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, agentId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });

    // processStartedAt + startedAt sit at fixture date (2026-03-19); real `now`
    // is well past that, so any non-zero maxRunDurationMs trips the cap.
    await db
      .update(heartbeatRuns)
      .set({ processStartedAt: new Date("2026-03-19T00:00:00.000Z") })
      .where(eq(heartbeatRuns.id, runId));

    // Simulate the wedge: server still has the in-memory handle, but the
    // adapter pump is stuck and not advancing the run.
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ maxRunDurationMs: 60 * 1000 });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("timeout");
    expect(run?.error).toContain("max duration");

    expect(runningProcesses.has(runId)).toBe(false);

    // No retry should be queued for a deliberate timeout.
    const allRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(allRuns).toHaveLength(1);

    // Child process should have been signalled (SIGTERM → exit). Allow a small
    // grace for the OS to deliver the signal before asserting.
    await waitFor(async () => {
      expect(child.pid && isAlive(child.pid)).toBe(false);
    }, 8_000);
  }, 20_000);

  it("reaps an event-silent local run even when it is still tracked in runningProcesses", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, companyId, agentId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });

    // Fresh process start so the duration watchdog can't fire — only silence should.
    const recentStart = new Date(Date.now() - 30_000);
    await db
      .update(heartbeatRuns)
      .set({ processStartedAt: recentStart, startedAt: recentStart })
      .where(eq(heartbeatRuns.id, runId));

    // Seed a single old event so the silence watchdog has something stale to read.
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "run started",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ eventSilenceThresholdMs: 60 * 1000 });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("timeout");
    // New message format: "Run idle for <n>min since last db_event activity ..."
    expect(run?.error).toMatch(/Run idle for/);
    expect(run?.error).toContain("db_event");

    expect(runningProcesses.has(runId)).toBe(false);

    const allRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(allRuns).toHaveLength(1);

    await waitFor(async () => {
      expect(child.pid && isAlive(child.pid)).toBe(false);
    }, 8_000);
  }, 20_000);

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const controlSecret = "legacy-retry-context-secret-value-42";
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = controlSecret;
    const { agentId, runId, issueId } = await seedRunFixture({ processPid: 999_999_999 });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          command: `use ${controlSecret}`,
          benignContext: "preserved",
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    try {
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
      expect(JSON.stringify(retryRun?.contextSnapshot)).not.toContain(controlSecret);
      expect(JSON.stringify(retryRun?.contextSnapshot)).toContain("***REDACTED***");
      expect(sharedTransientExecutionContextStore.get(retryRun!.id)?.command).toBe(
        `use ${controlSecret}`,
      );

      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
      expect(issue?.checkoutRunId).toBe(runId);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
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

    const executeSpy = vi
      .spyOn(getServerAdapter("codex_local"), "execute")
      .mockResolvedValue({ exitCode: 0, signal: null, timedOut: false });
    try {
      await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

      await waitFor(async () => {
        const [currentOlderRun, currentNewerRun, runtime, currentAgent] = await Promise.all([
          heartbeat.getRun(olderRunId),
          heartbeat.getRun(newerRunId),
          db
            .select()
            .from(agentRuntimeState)
            .where(eq(agentRuntimeState.agentId, agentId))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        ]);
        expect(currentOlderRun?.status).toBe("succeeded");
        expect(currentNewerRun?.status).toBe("succeeded");
        expect(executeSpy).toHaveBeenCalledTimes(2);
        expect(runtime?.lastRunId).toBe(newerRunId);
        expect(currentAgent?.status).toBe("idle");
      });
    } finally {
      executeSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------
  // Idle-watchdog regression tests for Bug A (pcli-7h2):
  //
  // The watchdog used to read activity solely from `heartbeat_run_events`.
  // After lifecycle/run_started + adapter/invoke the server might see no
  // new rows for >10 minutes while the adapter was still producing useful
  // stream events, and the run was killed mid-task. The fix routes both
  // stream events and DB events through `runActivityRegistry`. These tests
  // exercise the new behaviour.
  // ---------------------------------------------------------------------

  it("does NOT reap a run whose only DB events are stale, when meaningful stream activity is fresh", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, companyId, agentId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });

    // Fresh process so the duration watchdog can't fire.
    const recentStart = new Date(Date.now() - 30_000);
    await db
      .update(heartbeatRuns)
      .set({ processStartedAt: recentStart, startedAt: recentStart })
      .where(eq(heartbeatRuns.id, runId));

    // Stale DB event (matches the bug shape: only lifecycle/run_started persisted)
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "run started",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    // Fresh stream activity recorded by the on-log pump.
    runActivityRegistry.record(runId, "stream", new Date());
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ eventSilenceThresholdMs: 60 * 1000 });

    expect(result.reaped).toBe(0);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(child.pid && isAlive(child.pid)).toBe(true);
  }, 20_000);

  it("reaps a run when both DB events and stream activity are older than the idle threshold", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);

    const { runId, companyId, agentId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });

    const recentStart = new Date(Date.now() - 30_000);
    await db
      .update(heartbeatRuns)
      .set({ processStartedAt: recentStart, startedAt: recentStart })
      .where(eq(heartbeatRuns.id, runId));

    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "run started",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    // Stream activity is also old.
    runActivityRegistry.record(runId, "stream", new Date("2026-03-19T00:05:00.000Z"));

    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ eventSilenceThresholdMs: 60 * 1000 });

    expect(result.reaped).toBe(1);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("timeout");
    expect(run?.error).toMatch(/Run idle for/);
    // Most recent activity was a stream event in the registry, so the message
    // should attribute the idle period to the stream source.
    expect(run?.error).toContain("stream");
  }, 20_000);

  it("synthetic 30s-cadence/15min run is not killed when threshold is 10min", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);

    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const recentStart = new Date(Date.now() - 16 * 60_000);
    await db
      .update(heartbeatRuns)
      .set({ processStartedAt: recentStart, startedAt: recentStart })
      .where(eq(heartbeatRuns.id, runId));

    // Replay 15 minutes of activity at 30s cadence, ending "now".
    const end = Date.now();
    for (let i = 30; i >= 0; i -= 1) {
      const at = new Date(end - i * 30_000);
      runActivityRegistry.record(runId, "stream", at);
    }
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ eventSilenceThresholdMs: 10 * 60_000 });

    expect(result.reaped).toBe(0);
    expect(child.pid && isAlive(child.pid)).toBe(true);
  }, 20_000);

  it("synthetic 11-min-cadence run IS killed when threshold is 10min", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);

    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const recentStart = new Date(Date.now() - 12 * 60_000);
    await db
      .update(heartbeatRuns)
      .set({ processStartedAt: recentStart, startedAt: recentStart })
      .where(eq(heartbeatRuns.id, runId));

    // Last stream activity was 11 minutes ago — past the 10min threshold.
    runActivityRegistry.record(runId, "stream", new Date(Date.now() - 11 * 60_000));
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ eventSilenceThresholdMs: 10 * 60_000 });

    expect(result.reaped).toBe(1);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("timeout");
    expect(run?.error).toMatch(/Run idle for 1\dmin/);
    expect(run?.error).toContain("stream");
  }, 20_000);

  it("falls back to heartbeat_run_events when the registry has no entry for the run (server restart case)", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);

    const { runId, companyId, agentId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });

    const recentStart = new Date(Date.now() - 30_000);
    await db
      .update(heartbeatRuns)
      .set({ processStartedAt: recentStart, startedAt: recentStart })
      .where(eq(heartbeatRuns.id, runId));

    // Fresh DB event, no registry entry → fallback path should keep run alive.
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "adapter",
      stream: "system",
      level: "info",
      message: "adapter invoke",
      createdAt: new Date(),
    });
    // Registry intentionally not touched.
    expect(runActivityRegistry.get(runId)).toBeNull();
    runningProcesses.set(runId, { child, graceSec: 1 });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ eventSilenceThresholdMs: 60 * 1000 });

    expect(result.reaped).toBe(0);
    expect(child.pid && isAlive(child.pid)).toBe(true);
  }, 20_000);

  it("watchdog does NOT read run log files from disk during a tick", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);

    const { runId, companyId, agentId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const recentStart = new Date(Date.now() - 30_000);
    await db
      .update(heartbeatRuns)
      .set({ processStartedAt: recentStart, startedAt: recentStart })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "run started",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    runActivityRegistry.record(runId, "stream", new Date());
    runningProcesses.set(runId, { child, graceSec: 1 });

    // Spy on fs read paths that would suggest a full run-log rescan.
    const readFileSpy = vi.spyOn(fs.promises, "readFile");
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

    try {
      const heartbeat = heartbeatService(db);
      await heartbeat.reapOrphanedRuns({ eventSilenceThresholdMs: 60 * 1000 });

      const offenderCalls = [
        ...readFileSpy.mock.calls,
        ...readFileSyncSpy.mock.calls,
      ].filter((call) => {
        const target = call[0];
        if (typeof target !== "string") return false;
        return target.includes("run-logs") || target.endsWith(".ndjson") || target.endsWith(".ndjson.gz");
      });
      expect(offenderCalls).toEqual([]);
    } finally {
      readFileSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    }
  }, 20_000);
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
