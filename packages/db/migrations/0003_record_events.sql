CREATE TABLE "outbox" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "outbox_tenant_id_app_id_event_id_pk" PRIMARY KEY("tenant_id","app_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "record_events" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"record_revision" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changes" jsonb NOT NULL,
	CONSTRAINT "record_events_tenant_id_app_id_event_id_pk" PRIMARY KEY("tenant_id","app_id","event_id"),
	CONSTRAINT "record_events_tenant_id_app_id_record_id_record_revision_unique" UNIQUE("tenant_id","app_id","record_id","record_revision")
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_app_id_event_id_record_events_tenant_id_app_id_event_id_fk" FOREIGN KEY ("tenant_id","app_id","event_id") REFERENCES "public"."record_events"("tenant_id","app_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_events" ADD CONSTRAINT "record_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_events" ADD CONSTRAINT "record_events_tenant_id_app_id_record_id_records_tenant_id_app_id_id_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_events" ADD CONSTRAINT "record_events_tenant_id_app_id_schema_version_app_versions_tenant_id_app_id_version_fk" FOREIGN KEY ("tenant_id","app_id","schema_version") REFERENCES "public"."app_versions"("tenant_id","app_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_events" ADD CONSTRAINT "record_events_tenant_id_actor_id_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","actor_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE record_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON record_events TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY tenant_scope ON outbox TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON record_events, outbox TO suzubase_runtime;
