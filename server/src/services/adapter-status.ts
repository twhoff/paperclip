import type { Db } from "@paperclipai/db";
import { adapterStatus } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";

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
  if (!errorCode) return true; // default "adapter_failed"
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
            updatedAt: now,
          },
        });
      return;
    }

    // Failure path — only count adapter-level failures against the adapter
    if (!isAdapterLevelFailure(errorCode)) {
      // Agent logic failure: don't change adapter status, just touch updatedAt
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

  return {
    recordRunOutcome,
    listAll,
    getByType,
  };
}
