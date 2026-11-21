CREATE TYPE "public"."file_state" AS ENUM('TEMPORARY', 'READY', 'ATTACHED', 'DELETED');--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'attachment' BEFORE 'user';--> statement-breakpoint
CREATE TABLE "file_references" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "file_references_tenant_id_app_id_record_id_field_id_file_id_pk" PRIMARY KEY("tenant_id","app_id","record_id","field_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text,
	"state" "file_state" DEFAULT 'TEMPORARY' NOT NULL,
	"reference_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "files_tenant_id_app_id_id_pk" PRIMARY KEY("tenant_id","app_id","id"),
	CONSTRAINT "file_reference_count_nonnegative" CHECK ("files"."reference_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "attachment_max_bytes" integer DEFAULT 1048576 NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "attachment_max_count" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "attachment_types" jsonb DEFAULT '["image/png","image/jpeg","application/pdf"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_tenant_id_app_id_record_id_records_tenant_id_app_id_id_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_tenant_id_app_id_field_id_fields_tenant_id_app_id_field_id_fk" FOREIGN KEY ("tenant_id","app_id","field_id") REFERENCES "public"."fields"("tenant_id","app_id","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_tenant_id_app_id_file_id_files_tenant_id_app_id_id_fk" FOREIGN KEY ("tenant_id","app_id","file_id") REFERENCES "public"."files"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_uploaded_by_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","uploaded_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_references_tenant_id_app_id_file_id_index" ON "file_references" USING btree ("tenant_id","app_id","file_id");
--> statement-breakpoint
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_references ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON files TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON file_references TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON files TO suzubase_runtime;
GRANT UPDATE (sha256, state, reference_count, deleted_at) ON files TO suzubase_runtime;
GRANT SELECT, INSERT, DELETE ON file_references TO suzubase_runtime;
GRANT UPDATE (attachment_max_bytes, attachment_max_count, attachment_types) ON apps TO suzubase_runtime;
