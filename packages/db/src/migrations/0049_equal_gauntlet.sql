CREATE TABLE "agent_emulation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"native_status" text NOT NULL,
	"metadata" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_emulation_sessions" ADD CONSTRAINT "agent_emulation_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_emulation_sessions" ADD CONSTRAINT "agent_emulation_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_emulation_sessions_one_active_per_agent_idx" ON "agent_emulation_sessions" USING btree ("agent_id") WHERE "agent_emulation_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "agent_emulation_sessions_active_company_agent_idx" ON "agent_emulation_sessions" USING btree ("company_id","agent_id","ended_at","expires_at");--> statement-breakpoint
CREATE INDEX "agent_emulation_sessions_run_id_idx" ON "agent_emulation_sessions" USING btree ("run_id");
