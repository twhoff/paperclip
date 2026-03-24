CREATE TABLE "batch_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anthropic_batch_id" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"request_counts" jsonb,
	"error_message" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_jobs_anthropic_batch_id_unique" UNIQUE("anthropic_batch_id")
);
--> statement-breakpoint
CREATE TABLE "batch_queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"custom_id" text NOT NULL,
	"adapter_type" text NOT NULL,
	"task_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"request_params_json" jsonb NOT NULL,
	"session_params_snapshot_json" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"batch_job_id" uuid,
	"result_json" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_queue_entries_custom_id_unique" UNIQUE("custom_id")
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "general" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "batch_queue_entries" ADD CONSTRAINT "batch_queue_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_queue_entries" ADD CONSTRAINT "batch_queue_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_queue_entries" ADD CONSTRAINT "batch_queue_entries_batch_job_id_batch_jobs_id_fk" FOREIGN KEY ("batch_job_id") REFERENCES "public"."batch_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_jobs_status_idx" ON "batch_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "batch_jobs_anthropic_batch_id_idx" ON "batch_jobs" USING btree ("anthropic_batch_id");--> statement-breakpoint
CREATE INDEX "batch_jobs_submitted_at_idx" ON "batch_jobs" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "batch_queue_entries_status_created_idx" ON "batch_queue_entries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "batch_queue_entries_custom_id_idx" ON "batch_queue_entries" USING btree ("custom_id");--> statement-breakpoint
CREATE INDEX "batch_queue_entries_batch_job_idx" ON "batch_queue_entries" USING btree ("batch_job_id");--> statement-breakpoint
CREATE INDEX "batch_queue_entries_company_agent_status_idx" ON "batch_queue_entries" USING btree ("company_id","agent_id","status");