ALTER TABLE "notifications"
  ALTER COLUMN "app_id" DROP NOT NULL,
  ALTER COLUMN "record_id" DROP NOT NULL,
  ALTER COLUMN "event_id" DROP NOT NULL;

ALTER TABLE "notifications"
  ADD COLUMN "source_type" text DEFAULT 'RECORD' NOT NULL,
  ADD COLUMN "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  ADD COLUMN "source_event_id" uuid,
  ADD COLUMN "dedup_key" text,
  ADD COLUMN "event_type" text,
  ADD COLUMN "target_role" text,
  ADD COLUMN "payload" jsonb;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_type_check"
  CHECK ("source_type" IN ('RECORD', 'SYSTEM'));

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_record_source_check"
  CHECK (
    ("source_type" = 'RECORD' AND "app_id" IS NOT NULL AND "record_id" IS NOT NULL AND "event_id" IS NOT NULL)
    OR
    ("source_type" = 'SYSTEM' AND "app_id" IS NULL AND "record_id" IS NULL AND "event_id" IS NULL)
  );

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_dedup_check"
  CHECK (
    ("source_type" = 'RECORD' AND "dedup_key" IS NULL)
    OR
    ("source_type" = 'SYSTEM' AND "source_event_id" IS NOT NULL AND "dedup_key" IS NOT NULL AND "event_type" IS NOT NULL)
  );

CREATE UNIQUE INDEX "notifications_system_dedup_idx"
  ON "notifications" ("tenant_id", "dedup_key", "user_id")
  WHERE "source_type" = 'SYSTEM';

CREATE INDEX "notifications_system_center_idx"
  ON "notifications" ("tenant_id", "user_id", "occurred_at" DESC, "id" DESC)
  WHERE "source_type" = 'SYSTEM';

GRANT SELECT, INSERT, UPDATE (read_at, email_state, email_attempts, email_next_at) ON notifications TO suzubase_runtime;
