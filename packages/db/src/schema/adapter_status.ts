import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

/**
 * Instance-level adapter health status, updated by two independent paths:
 *
 * 1. **Run outcomes** — the heartbeat service updates this table after every
 *    agent run completes (success resets failures; adapter-level failure
 *    increments consecutive_failures and may degrade/offline the adapter).
 *
 * 2. **Dedicated health probes** — the scheduler periodically calls each
 *    adapter's `testEnvironment()` directly (no agent wakeup required) and
 *    records the result in the `last_probe_*` columns.
 *
 * Each row represents one adapter type (e.g. `claude_local`, `copilot_cli`).
 */
export const adapterStatus = pgTable("adapter_status", {
  adapterType: text("adapter_type").primaryKey(),
  status: text("status").notNull().default("unknown"),
  statusMessage: text("status_message"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastErrorCode: text("last_error_code"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  /** When the last dedicated health probe ran. */
  lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
  /** Result of the last dedicated probe: "pass", "warn", or "fail". */
  lastProbeStatus: text("last_probe_status"),
  /** Human-readable summary from the last probe's environment checks. */
  lastProbeMessage: text("last_probe_message"),
  /** What produced the current status value: "dedicated" or "run_outcome". */
  probeSource: text("probe_source"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
