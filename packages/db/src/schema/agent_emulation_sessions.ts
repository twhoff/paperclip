import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentEmulationSessions = pgTable(
  "agent_emulation_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    nativeStatus: text("native_status").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneActivePerAgent: uniqueIndex("agent_emulation_sessions_one_active_per_agent_idx")
      .on(table.agentId)
      .where(sql`${table.endedAt} is null`),
    activeCompanyAgentIdx: index("agent_emulation_sessions_active_company_agent_idx").on(
      table.companyId,
      table.agentId,
      table.endedAt,
      table.expiresAt,
    ),
    runIdx: index("agent_emulation_sessions_run_id_idx").on(table.runId),
  }),
);
