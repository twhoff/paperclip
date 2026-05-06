import type { Server as HttpServer } from "node:http";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { conflict } from "../errors.js";
import { agentService } from "./agents.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";

export type ShutdownPhase = "idle" | "draining" | "drained" | "stopping";

export interface ShutdownState {
  phase: ShutdownPhase;
  startedAt: string | null;
  deadline: string | null;
  timeoutMs: number;
  exitProcess: boolean;
  inFlightAgentCount: number;
  inFlightAgentIds: string[];
  initiatorActorId: string | null;
}

export interface ShutdownInitiateOptions {
  timeoutMs?: number;
  exitProcess?: boolean;
  actorId: string;
  actorType: "user" | "agent" | "system";
}

export interface ShutdownResumeOptions {
  actorId: string;
  actorType: "user" | "agent" | "system";
}

export interface ShutdownTargets {
  httpServer: HttpServer;
  stopEmbeddedPostgres?: () => Promise<void>;
  exit?: (code?: number) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 1_000;
const SHUTDOWN_REASON = "shutdown" as const;

type InternalState = {
  phase: ShutdownPhase;
  startedAt: Date | null;
  deadline: Date | null;
  timeoutMs: number;
  exitProcess: boolean;
  inFlightAgentIds: Set<string>;
  initiatorActorId: string | null;
  affectedCompanyIds: Set<string>;
};

function createIdleState(): InternalState {
  return {
    phase: "idle",
    startedAt: null,
    deadline: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    exitProcess: false,
    inFlightAgentIds: new Set(),
    initiatorActorId: null,
    affectedCompanyIds: new Set(),
  };
}

export function shutdownService(db: Db) {
  let state: InternalState = createIdleState();
  let pollTimer: NodeJS.Timeout | null = null;
  let targets: ShutdownTargets | null = null;
  const agents$ = agentService(db);
  const heartbeat$ = heartbeatService(db);

  function snapshot(): ShutdownState {
    return {
      phase: state.phase,
      startedAt: state.startedAt ? state.startedAt.toISOString() : null,
      deadline: state.deadline ? state.deadline.toISOString() : null,
      timeoutMs: state.timeoutMs,
      exitProcess: state.exitProcess,
      inFlightAgentCount: state.inFlightAgentIds.size,
      inFlightAgentIds: Array.from(state.inFlightAgentIds),
      initiatorActorId: state.initiatorActorId,
    };
  }

  function clampTimeout(input: number | undefined): number {
    if (typeof input !== "number" || !Number.isFinite(input)) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(input)));
  }

  function setTargets(next: ShutdownTargets) {
    targets = next;
  }

  async function logSystemActivity(action: string, details?: Record<string, unknown>) {
    const companyIds = Array.from(state.affectedCompanyIds);
    if (companyIds.length === 0) return;
    for (const companyId of companyIds) {
      try {
        await logActivity(db, {
          companyId,
          actorType: state.initiatorActorId ? "user" : "system",
          actorId: state.initiatorActorId ?? "system",
          action,
          entityType: "system",
          entityId: "shutdown",
          details: details ?? null,
        });
      } catch (err) {
        logger.warn({ err, action, companyId }, "Failed to write shutdown activity log entry");
      }
    }
  }

  async function listShutdownPausedAgents(): Promise<{ id: string; companyId: string }[]> {
    const rows = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(and(eq(agents.status, "paused"), eq(agents.pauseReason, SHUTDOWN_REASON)));
    return rows;
  }

  async function pollInFlight(): Promise<Set<string>> {
    if (state.affectedCompanyIds.size === 0) return new Set();
    const rows = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.agentId) ids.add(row.agentId);
    }
    return ids;
  }

  function clearTimer() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function forceCancelStragglers() {
    for (const agentId of state.inFlightAgentIds) {
      try {
        await heartbeat$.cancelActiveForAgent(agentId);
      } catch (err) {
        logger.warn({ err, agentId }, "Failed to cancel in-flight run during shutdown timeout");
      }
    }
  }

  async function performExit() {
    if (!targets) {
      logger.error("Shutdown targets not registered; cannot exit process");
      return;
    }
    const { httpServer, stopEmbeddedPostgres, exit } = targets;
    state.phase = "stopping";
    await logSystemActivity("system.shutdown.completed", { exitProcess: true });
    logger.info("Shutdown: stopping HTTP server");
    await new Promise<void>((resolve) => {
      // Allow time for any final SSE/log writes to flush.
      setTimeout(() => {
        httpServer.close((err) => {
          if (err) logger.warn({ err }, "Error closing HTTP server during shutdown");
          resolve();
        });
      }, 500);
    });
    if (stopEmbeddedPostgres) {
      try {
        logger.info("Shutdown: stopping embedded Postgres");
        await stopEmbeddedPostgres();
      } catch (err) {
        logger.error({ err }, "Failed to stop embedded Postgres during shutdown");
      }
    }
    logger.info("Shutdown complete; exiting process");
    (exit ?? process.exit)(0);
  }

  async function tick() {
    if (state.phase !== "draining") return;
    try {
      const inflight = await pollInFlight();
      state.inFlightAgentIds = inflight;

      const drained = inflight.size === 0;
      const timedOut = state.deadline !== null && Date.now() >= state.deadline.getTime();

      if (!drained && !timedOut) return;

      clearTimer();

      if (timedOut && !drained) {
        logger.warn(
          { remaining: Array.from(inflight), timeoutMs: state.timeoutMs },
          "Shutdown drain timed out; force-cancelling stragglers",
        );
        await forceCancelStragglers();
      }

      if (state.exitProcess) {
        await performExit();
        return;
      }

      state.phase = "drained";
      state.inFlightAgentIds = new Set();
      logger.info("Shutdown drain complete; agents paused, server remains up");
      await logSystemActivity("system.shutdown.drained", { exitProcess: false });
    } catch (err) {
      logger.error({ err }, "Shutdown drain tick failed");
    }
  }

  async function initiate(opts: ShutdownInitiateOptions): Promise<ShutdownState> {
    if (state.phase !== "idle") {
      throw conflict("Shutdown already in progress", { phase: state.phase });
    }
    const timeoutMs = clampTimeout(opts.timeoutMs);
    const exitProcess = Boolean(opts.exitProcess);
    const startedAt = new Date();
    const deadline = new Date(startedAt.getTime() + timeoutMs);

    // Atomically pause every non-terminated, non-shutdown-already agent and
    // capture the affected company set in one query.
    const pausedRows = await db
      .update(agents)
      .set({
        status: "paused",
        pauseReason: SHUTDOWN_REASON,
        pausedAt: startedAt,
        updatedAt: startedAt,
      })
      .where(and(ne(agents.status, "terminated"), ne(agents.status, "paused")))
      .returning({ id: agents.id, companyId: agents.companyId });

    state = {
      phase: "draining",
      startedAt,
      deadline,
      timeoutMs,
      exitProcess,
      inFlightAgentIds: new Set(pausedRows.map((r) => r.id)),
      initiatorActorId: opts.actorId,
      affectedCompanyIds: new Set(pausedRows.map((r) => r.companyId)),
    };

    await logSystemActivity("system.shutdown.initiated", {
      exitProcess,
      timeoutMs,
      affectedAgentCount: pausedRows.length,
    });

    pollTimer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    // Run the first tick immediately to short-circuit when nothing is in-flight.
    void tick();

    return snapshot();
  }

  async function resume(opts: ShutdownResumeOptions): Promise<ShutdownState> {
    if (state.phase !== "draining" && state.phase !== "drained") {
      throw conflict("No active shutdown to resume", { phase: state.phase });
    }
    const fromPhase = state.phase;
    clearTimer();
    // Update initiator to the resumer for the trailing activity log entry.
    state.initiatorActorId = opts.actorId;

    const shutdownPaused = await listShutdownPausedAgents();
    for (const row of shutdownPaused) {
      try {
        await agents$.resume(row.id);
      } catch (err) {
        logger.warn({ err, agentId: row.id }, "Failed to resume shutdown-paused agent");
      }
    }

    const action = fromPhase === "draining" ? "system.shutdown.cancelled" : "system.shutdown.resumed";
    await logSystemActivity(action, {
      resumedAgentCount: shutdownPaused.length,
      fromPhase,
    });

    state = createIdleState();
    return snapshot();
  }

  function getState(): ShutdownState {
    return snapshot();
  }

  return {
    setTargets,
    initiate,
    resume,
    getState,
    // Test-only helpers — useful for unit tests.
    _internal: { tick, clearTimer },
  };
}

export type ShutdownService = ReturnType<typeof shutdownService>;
