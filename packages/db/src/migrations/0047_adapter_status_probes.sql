ALTER TABLE "adapter_status" ADD COLUMN "last_probe_at" timestamp with time zone;
ALTER TABLE "adapter_status" ADD COLUMN "last_probe_status" text;
ALTER TABLE "adapter_status" ADD COLUMN "last_probe_message" text;
ALTER TABLE "adapter_status" ADD COLUMN "probe_source" text;
