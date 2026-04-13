import type { Db } from "@paperclipai/db";
import { adapterStatus, agents } from "@paperclipai/db";
import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { findServerAdapter } from "../adapters/index.js";
import { logger } from "../middleware/logger.js";

/**
 * Thresholds for adapter status transitions based on consecutive failures.
 *   1–2 failures → degraded
 *   3+  failures → offline
 */
const DEGRADED_THRESHOLD = 1;
const OFFLINE_THRESHOLD = 3;

/** Backoff tiers for next_check_at when offline (minutes). */
const BACKOFF_TIERS_MIN = [5, 15, 30, 60];

function nextBackoffMinutes(consecutiveFailures: number): number {
  const idx = Math.min(consecutiveFailures - OFFLINE_THRESHOLD, BACKOFF_TIERS_MIN.length - 1);
  return BACKOFF_TIERS_MIN[Math.max(0, idx)];
}

/**
 * Parse rate-limit / retry-after hints from an error message.
 * Returns an absolute Date if a hint is found, or null otherwise.
 */
function parseRetryAfterHint(errorMessage: string | null | undefined): Date | null {
  if (!errorMessage) return null;

  // "retry after <seconds>" or "Retry-After: <seconds>"
  const retrySecs = errorMessage.match(/retry[- ]?after[:\s]+(\d+)/i);
  if (retrySecs) {
    const secs = parseInt(retrySecs[1], 10);
    if (secs > 0 && secs < 86_400) {
      return new Date(Date.now() + secs * 1000);
    }
  }

  // "resets at <ISO datetime>" or "back online at <time>"
  const resetAt = errorMessage.match(
    /(?:resets?\s+at|back\s+online\s+at|available\s+(?:at|after))\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (resetAt) {
    const d = new Date(resetAt[1]);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now()) {
      return d;
    }
  }

  // "in <N> minutes" / "in <N> hours"
  const inMinutes = errorMessage.match(/in\s+(\d+)\s+minute/i);
  if (inMinutes) {
    const mins = parseInt(inMinutes[1], 10);
    if (mins > 0 && mins < 1440) {
      return new Date(Date.now() + mins * 60_000);
    }
  }
  const inHours = errorMessage.match(/in\s+(\d+)\s+hour/i);
  if (inHours) {
    const hrs = parseInt(inHours[1], 10);
    if (hrs > 0 && hrs < 48) {
      return new Date(Date.now() + hrs * 3_600_000);
    }
  }

  // "resets 12pm" / "resets 10pm (Australia/Melbourne)" — 12-hour clock without "at"
  const resetsAmPm = errorMessage.match(
    /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i,
  );
  if (resetsAmPm) {
    let hour = parseInt(resetsAmPm[1], 10);
    const min = resetsAmPm[2] ? parseInt(resetsAmPm[2], 10) : 0;
    const ampm = resetsAmPm[3].toLowerCase();
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    // Build a target date in the local server timezone (best-effort)
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, min, 0, 0);
    // If the target time has already passed today, assume tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  // "resets 25 Apr at 10:46am" (absolute date, no year)
  const resetsAbs = errorMessage.match(
    /resets?\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+at\s+(\d{1,2}):(\d{2})(am|pm)/i,
  );
  if (resetsAbs) {
    const day = parseInt(resetsAbs[1], 10);
    const monthStr = resetsAbs[2].toLowerCase();
    const hourRaw = parseInt(resetsAbs[3], 10);
    const min = parseInt(resetsAbs[4], 10);
    const ampm = resetsAbs[5].toLowerCase();
    const monthMap: Record<string, number> = {
      jan: 0, january: 0,
      feb: 1, february: 1,
      mar: 2, march: 2,
      apr: 3, april: 3,
      may: 4,
      jun: 5, june: 5,
      jul: 6, july: 6,
      aug: 7, august: 7,
      sep: 8, sept: 8, september: 8,
      oct: 9, october: 9,
      nov: 10, november: 10,
      dec: 11, december: 11,
    };
    const month = monthMap[monthStr];
    if (month === undefined) return null;
    let hour = hourRaw;
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const now = new Date();
    let year = now.getFullYear();
    let target = new Date(year, month, day, hour, min, 0, 0);
    // If the date has already passed this year, assume next year
    if (target.getTime() <= now.getTime()) {
      target = new Date(year + 1, month, day, hour, min, 0, 0);
    }
    return target;
  }

  return null;
}

/** Error codes that indicate an adapter infrastructure problem (not agent logic). */
const ADAPTER_ERROR_CODES = new Set([
  "adapter_failed",
  "adapter_timeout",
  "timeout",
  "spawn_failed",
  "process_lost",
  "process_crash",
  "connection_refused",
  "rate_limit",
  "quota_exceeded",
  "authentication_error",
]);

function isAdapterLevelFailure(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false; // unknown error type — don't blame the adapter
  return ADAPTER_ERROR_CODES.has(errorCode);
}

export function adapterStatusService(db: Db) {
  /**
   * Update adapter status after a heartbeat run completes.
   * Called from the heartbeat service with the run outcome.
   */
  async function recordRunOutcome(input: {
    adapterType: string;
    succeeded: boolean;
    errorMessage?: string | null;
    errorCode?: string | null;
  }) {
    const { adapterType, succeeded, errorMessage, errorCode } = input;
    const now = new Date();

    if (succeeded) {
      await db
        .insert(adapterStatus)
        .values({
          adapterType,
          status: "online",
          statusMessage: null,
          lastSuccessAt: now,
          lastError: null,
          lastErrorCode: null,
          consecutiveFailures: 0,
          consecutiveSuccesses: 1,
          nextCheckAt: null,
          probeSource: "run_outcome",
          updatedAt: now,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: adapterStatus.adapterType,
          set: {
            status: "online",
            statusMessage: null,
            lastSuccessAt: now,
            lastError: null,
            lastErrorCode: null,
            consecutiveFailures: 0,
            consecutiveSuccesses: sql`${adapterStatus.consecutiveSuccesses} + 1`,
            nextCheckAt: null,
            probeSource: "run_outcome",
            updatedAt: now,
          },
        });
      return;
    }

    // Failure path — only count adapter-level failures against the adapter
    if (!isAdapterLevelFailure(errorCode)) {
        // Agent logic failure: the adapter itself executed fine.  If the adapter
        // was in "probing" state (retry window just elapsed), promote it to
        // "online" — the probe confirmed the adapter works.  Otherwise just
        // touch updatedAt so we don't discard the existing status.
        const existing = await db
          .select({ status: adapterStatus.status })
          .from(adapterStatus)
          .where(eq(adapterStatus.adapterType, adapterType))
          .then((rows) => rows[0] ?? null);

        if (existing?.status === "probing") {
          await db
            .insert(adapterStatus)
            .values({
              adapterType,
              status: "online",
              statusMessage: null,
              lastSuccessAt: now,
              lastError: null,
              lastErrorCode: null,
              consecutiveFailures: 0,
              consecutiveSuccesses: 1,
              nextCheckAt: null,
              probeSource: "run_outcome",
              updatedAt: now,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: adapterStatus.adapterType,
              set: {
                status: "online",
                statusMessage: null,
                lastSuccessAt: now,
                lastError: null,
                lastErrorCode: null,
                consecutiveFailures: 0,
                consecutiveSuccesses: sql`${adapterStatus.consecutiveSuccesses} + 1`,
                nextCheckAt: null,
                probeSource: "run_outcome",
                updatedAt: now,
              },
            });
        } else {
          await db
            .insert(adapterStatus)
            .values({
              adapterType,
              status: "online",
              updatedAt: now,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: adapterStatus.adapterType,
              set: { updatedAt: now },
            });
        }
      return;
    }

    // Read current state to compute next consecutive count
    const current = await db
      .select()
      .from(adapterStatus)
      .where(eq(adapterStatus.adapterType, adapterType))
      .then((rows) => rows[0] ?? null);

    const prevFailures = current?.consecutiveFailures ?? 0;
    const newFailures = prevFailures + 1;

    let newStatus: string;
    if (newFailures >= OFFLINE_THRESHOLD) {
      newStatus = "offline";
    } else if (newFailures >= DEGRADED_THRESHOLD) {
      newStatus = "degraded";
    } else {
      newStatus = current?.status ?? "unknown";
    }

    // Determine next_check_at from error message or backoff
    let nextCheckAt: Date | null = parseRetryAfterHint(errorMessage);
    if (!nextCheckAt && newFailures >= OFFLINE_THRESHOLD) {
      const backoffMin = nextBackoffMinutes(newFailures);
      nextCheckAt = new Date(now.getTime() + backoffMin * 60_000);
    }
    // Degraded adapters also get a check time so probing can clear stale entries
    if (!nextCheckAt && newFailures >= DEGRADED_THRESHOLD) {
      nextCheckAt = new Date(now.getTime() + BACKOFF_TIERS_MIN[0] * 60_000);
    }

    const truncatedError = errorMessage ? errorMessage.slice(0, 2000) : null;

    await db
      .insert(adapterStatus)
      .values({
        adapterType,
        status: newStatus,
        statusMessage: truncatedError,
        lastFailureAt: now,
        lastError: truncatedError,
        lastErrorCode: errorCode ?? "adapter_failed",
        consecutiveFailures: newFailures,
        consecutiveSuccesses: 0,
        nextCheckAt,
        probeSource: "run_outcome",
        updatedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: adapterStatus.adapterType,
        set: {
          status: newStatus,
          statusMessage: truncatedError,
          lastFailureAt: now,
          lastError: truncatedError,
          lastErrorCode: errorCode ?? "adapter_failed",
          consecutiveFailures: newFailures,
          consecutiveSuccesses: 0,
          nextCheckAt,
          probeSource: "run_outcome",
          updatedAt: now,
        },
      });
  }

  /** Get status of all adapters. */
  async function listAll() {
    return db.select().from(adapterStatus);
  }

  /** Get status of a single adapter. */
  async function getByType(adapterType: string) {
    return db
      .select()
      .from(adapterStatus)
      .where(eq(adapterStatus.adapterType, adapterType))
      .then((rows) => rows[0] ?? null);
  }

/**
     * For every offline/degraded adapter whose retry window has elapsed, transition
     * the status to "probing" so a lightweight probe run can be enqueued.
     *
     * Returns the adapter types that were transitioned.
     *
     * Formerly called resetExpiredStatuses — retained as an alias for callers that
     * only need the list of adapters whose windows elapsed.
     */
    async function markExpiredForProbing(): Promise<string[]> {
      const now = new Date();
      const reset = await db
        .update(adapterStatus)
        .set({
          status: "probing",
          nextCheckAt: null,
          statusMessage: "probing adapter after retry window",
          consecutiveFailures: 0,
          lastError: null,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(
          and(
            isNotNull(adapterStatus.nextCheckAt),
            lte(adapterStatus.nextCheckAt, now),
            inArray(adapterStatus.status, ["offline", "degraded"]),
          ),
        )
        .returning({ adapterType: adapterStatus.adapterType });
      return reset.map((r) => r.adapterType);
    }

    /** Back-compat alias used by the API routes that just need to surface fresh status. */
    const resetExpiredStatuses = markExpiredForProbing;

    /** Return all adapters currently in "probing" state. */
    async function listProbing(): Promise<string[]> {
      const rows = await db
        .select({ adapterType: adapterStatus.adapterType })
        .from(adapterStatus)
        .where(eq(adapterStatus.status, "probing"));
      return rows.map((r) => r.adapterType);
    }

    /**
     * Run a dedicated environment health check for a single adapter type.
     *
     * Resolves a representative adapter config from any agent (regardless of
     * status) and calls the adapter's `testEnvironment()` directly — no agent
     * wakeup or process spawn required.
     */
    async function probeAdapterHealth(adapterType: string): Promise<AdapterEnvironmentTestResult | null> {
      const adapter = findServerAdapter(adapterType);
      if (!adapter || !adapter.testEnvironment) return null;

      // Find a representative agent to source a company ID and config from.
      // Prefer the most recently successful agent, fall back to any agent.
      const representativeAgent = await db
        .select({
          companyId: agents.companyId,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(eq(agents.adapterType, adapterType))
        .orderBy(desc(agents.lastHeartbeatAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!representativeAgent) {
        // No agents use this adapter type at all — nothing to probe against.
        return null;
      }

      const config = (representativeAgent.adapterConfig ?? {}) as Record<string, unknown>;
      const companyId = representativeAgent.companyId;
      const now = new Date();

      let result: AdapterEnvironmentTestResult;
      try {
        result = await Promise.race([
          adapter.testEnvironment({
            companyId,
            adapterType,
            config,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("adapter probe timed out after 30s")), 30_000),
          ),
        ]);
      } catch (err) {
        // testEnvironment threw or timed out — record as a probe failure.
        const message = err instanceof Error ? err.message : String(err);
        result = {
          adapterType,
          status: "fail",
          checks: [{ code: "probe_error", level: "error", message }],
          testedAt: now.toISOString(),
        };
      }

      const probeMessage = result.checks
        .map((c) => `[${c.level}] ${c.message}`)
        .join("; ")
        .slice(0, 2000) || null;

      if (result.status === "pass") {
        await db
          .insert(adapterStatus)
          .values({
            adapterType,
            status: "online",
            statusMessage: null,
            lastSuccessAt: now,
            lastError: null,
            lastErrorCode: null,
            consecutiveFailures: 0,
            consecutiveSuccesses: 1,
            nextCheckAt: null,
            lastProbeAt: now,
            lastProbeStatus: "pass",
            lastProbeMessage: probeMessage,
            probeSource: "dedicated",
            updatedAt: now,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: adapterStatus.adapterType,
            set: {
              status: "online",
              statusMessage: null,
              lastSuccessAt: now,
              lastError: null,
              lastErrorCode: null,
              consecutiveFailures: 0,
              consecutiveSuccesses: sql`${adapterStatus.consecutiveSuccesses} + 1`,
              nextCheckAt: null,
              lastProbeAt: now,
              lastProbeStatus: "pass",
              lastProbeMessage: probeMessage,
              probeSource: "dedicated",
              updatedAt: now,
            },
          });
      } else if (result.status === "warn") {
        await db
          .insert(adapterStatus)
          .values({
            adapterType,
            status: "degraded",
            statusMessage: probeMessage,
            lastProbeAt: now,
            lastProbeStatus: "warn",
            lastProbeMessage: probeMessage,
            probeSource: "dedicated",
            consecutiveFailures: 1,
            consecutiveSuccesses: 0,
            nextCheckAt: new Date(now.getTime() + BACKOFF_TIERS_MIN[0] * 60_000),
            updatedAt: now,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: adapterStatus.adapterType,
            set: {
              status: "degraded",
              statusMessage: probeMessage,
              lastProbeAt: now,
              lastProbeStatus: "warn",
              lastProbeMessage: probeMessage,
              probeSource: "dedicated",
              consecutiveFailures: 1,
              consecutiveSuccesses: 0,
              nextCheckAt: new Date(now.getTime() + BACKOFF_TIERS_MIN[0] * 60_000),
              updatedAt: now,
            },
          });
      } else {
        // fail
        const errorHint = result.checks.find((c) => c.level === "error")?.message ?? null;
        const nextCheckAt = parseRetryAfterHint(errorHint)
          ?? new Date(now.getTime() + BACKOFF_TIERS_MIN[0] * 60_000);

        await db
          .insert(adapterStatus)
          .values({
            adapterType,
            status: "offline",
            statusMessage: probeMessage,
            lastFailureAt: now,
            lastError: probeMessage,
            lastErrorCode: "probe_failed",
            consecutiveFailures: OFFLINE_THRESHOLD,
            consecutiveSuccesses: 0,
            nextCheckAt,
            lastProbeAt: now,
            lastProbeStatus: "fail",
            lastProbeMessage: probeMessage,
            probeSource: "dedicated",
            updatedAt: now,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: adapterStatus.adapterType,
            set: {
              status: "offline",
              statusMessage: probeMessage,
              lastFailureAt: now,
              lastError: probeMessage,
              lastErrorCode: "probe_failed",
              consecutiveFailures: OFFLINE_THRESHOLD,
              consecutiveSuccesses: 0,
              nextCheckAt,
              lastProbeAt: now,
              lastProbeStatus: "fail",
              lastProbeMessage: probeMessage,
              probeSource: "dedicated",
              updatedAt: now,
            },
          });
      }

      return result;
    }

    /**
     * Run dedicated health probes for all adapters currently in "probing" state.
     *
     * Called from the heartbeat scheduler's `tickTimers()` after
     * `markExpiredForProbing()` has transitioned eligible adapters.
     *
     * Probes run sequentially to avoid resource contention on the local machine.
     */
    async function runScheduledProbes(): Promise<{ probed: string[]; failed: string[] }> {
      const probingTypes = await listProbing();
      const probed: string[] = [];
      const failed: string[] = [];

      for (const adapterType of probingTypes) {
        try {
          const result = await probeAdapterHealth(adapterType);
          if (result) {
            probed.push(adapterType);
            if (result.status === "fail") {
              failed.push(adapterType);
            }
          } else {
            // No adapter module or no agents — clear the probing state to offline
            // so it doesn't sit in "probing" forever.
            const now = new Date();
            await db
              .update(adapterStatus)
              .set({
                status: "offline",
                statusMessage: "no agents configured for this adapter type",
                lastProbeAt: now,
                lastProbeStatus: "fail",
                lastProbeMessage: "no agents configured for this adapter type",
                probeSource: "dedicated",
                nextCheckAt: new Date(now.getTime() + BACKOFF_TIERS_MIN[BACKOFF_TIERS_MIN.length - 1] * 60_000),
                updatedAt: now,
              })
              .where(eq(adapterStatus.adapterType, adapterType));
            failed.push(adapterType);
          }
        } catch (err) {
          logger.warn({ err, adapterType }, "adapter health probe threw unexpectedly");
          failed.push(adapterType);
        }
      }

      return { probed, failed };
    }

    return {
      recordRunOutcome,
      listAll,
      getByType,
      markExpiredForProbing,
      resetExpiredStatuses,
      listProbing,
      probeAdapterHealth,
      runScheduledProbes,
  };
}
