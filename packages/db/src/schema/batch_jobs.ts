import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

export const batchJobs = pgTable(
  "batch_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The Anthropic batch ID returned from POST /v1/messages/batches
    anthropicBatchId: text("anthropic_batch_id").notNull().unique(),

    // Status mirrors Anthropic: in_progress | ended | failed | expired
    status: text("status").notNull().default("in_progress"),

    // Number of entries included in this batch
    entryCount: integer("entry_count").notNull().default(0),

    // Anthropic-reported processing counts (from GET /v1/messages/batches/{id})
    requestCounts: jsonb("request_counts").$type<{
      processing: number;
      succeeded: number;
      errored: number;
      canceled: number;
      expired: number;
    }>(),

    errorMessage: text("error_message"),

    // Timestamps
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("batch_jobs_status_idx").on(table.status),
    anthropicBatchIdIdx: index("batch_jobs_anthropic_batch_id_idx").on(table.anthropicBatchId),
    submittedAtIdx: index("batch_jobs_submitted_at_idx").on(table.submittedAt),
  }),
);
