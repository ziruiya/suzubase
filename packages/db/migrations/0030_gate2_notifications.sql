CREATE TABLE "notifications" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"email_state" text NOT NULL,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	"email_next_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "notifications_tenant_id_app_id_event_id_user_id_rule_key_unique" UNIQUE("tenant_id","app_id","event_id","user_id","rule_key")
);
--> statement-breakpoint
ALTER TABLE "app_versions" ADD COLUMN "notification_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "notifications" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notification_outbox_fk" FOREIGN KEY ("tenant_id","app_id","event_id") REFERENCES "public"."outbox"("tenant_id","app_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notification_record_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notification_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_center_idx" ON "notifications" USING btree ("tenant_id","user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_email_idx" ON "notifications" USING btree ("tenant_id","email_next_at") WHERE "notifications"."email_state" = 'pending';
--> statement-breakpoint
GRANT UPDATE (notification_rules) ON app_versions TO suzubase_runtime;
GRANT UPDATE (notifications, processed_at) ON outbox TO suzubase_runtime;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON notifications TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE (read_at, email_state, email_attempts, email_next_at) ON notifications TO suzubase_runtime;
