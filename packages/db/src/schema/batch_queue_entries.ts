import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { batchJobs } from "./batch_jobs.js";

export const batchQueueEntries = pgTable(
  "batch_queue_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),

    // The unique ID sent to Anthropic as custom_id (format: "pclp_{id-no-dashes}")
    customId: text("custom_id").notNull().unique(),

    // Adapter task identity
    adapterType: text("adapter_type").notNull(),
    taskKey: text("task_key").notNull(),
    runId: uuid("run_id").notNull(),

    // The serialized Messages API request params (model, messages, system, max_tokens)
    requestParamsJson: jsonb("request_params_json").$type<Record<string, unknown>>().notNull(),

    // The sessionParams snapshot at queue time, restored on result routing
    sessionParamsSnapshotJson: jsonb("session_params_snapshot_json").$type<Record<string, unknown>>(),

    // Status lifecycle: pending -> submitted -> completed | failed | expired | cancelled
    status: text("status").notNull().default("pending"),

    // Set when this entry is picked up by the submission service
    batchJobId: uuid("batch_job_id").references(() => batchJobs.id, { onDelete: "set null" }),

    // Set when Anthropic returns a result
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCreatedIdx: index("batch_queue_entries_status_created_idx").on(table.status, table.createdAt),
    customIdIdx: index("batch_queue_entries_custom_id_idx").on(table.customId),
    batchJobIdx: index("batch_queue_entries_batch_job_idx").on(table.batchJobId),
    companyAgentStatusIdx: index("batch_queue_entries_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
  }),
);
