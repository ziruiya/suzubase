CREATE TABLE "comment_mentions" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"offset" integer NOT NULL,
	"length" integer NOT NULL,
	CONSTRAINT "comment_mentions_tenant_id_app_id_record_id_comment_id_offset_pk" PRIMARY KEY("tenant_id","app_id","record_id","comment_id","offset")
);
--> statement-breakpoint
CREATE TABLE "record_comments" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "record_comments_tenant_id_app_id_record_id_id_pk" PRIMARY KEY("tenant_id","app_id","record_id","id")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "comments_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "record_events" ADD COLUMN "object_type" text DEFAULT 'record' NOT NULL;--> statement-breakpoint
ALTER TABLE "record_events" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_fk" FOREIGN KEY ("tenant_id","app_id","record_id","comment_id") REFERENCES "public"."record_comments"("tenant_id","app_id","record_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_record_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_comments_page_idx" ON "record_comments" USING btree ("tenant_id","app_id","record_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
GRANT UPDATE (comments_enabled) ON apps TO suzubase_runtime;
ALTER TABLE record_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_mentions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON record_comments TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON comment_mentions TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE (deleted_at) ON record_comments TO suzubase_runtime;
GRANT SELECT, INSERT ON comment_mentions TO suzubase_runtime;
UPDATE record_events SET object_type = 'workflow'
  WHERE kind IN ('workflow-action', 'workflow-reassigned', 'WORKFLOW_REPAIR');
