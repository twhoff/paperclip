import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

/**
 * Instance-level adapter health status, updated passively as agents run.
 *
 * Each row represents one adapter type (e.g. `claude_local`, `copilot_cli`).
 * The heartbeat service updates this table after every run completes:
 *   - On success: status → online, consecutive_failures reset
 *   - On failure: consecutive_failures++, status → degraded/offline
 *
 * The `next_check_at` column supports retry scheduling when an adapter is
 * offline — parsed from rate-limit error messages or set via exponential backoff.
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
