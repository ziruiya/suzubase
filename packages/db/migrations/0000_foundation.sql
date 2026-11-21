CREATE TYPE "public"."draft_status" AS ENUM('editing', 'validation-failed', 'publishable');--> statement-breakpoint
CREATE TYPE "public"."field_type" AS ENUM('text', 'number');--> statement-breakpoint
CREATE TABLE "app_counters" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"last_value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "app_counters_tenant_id_app_id_pk" PRIMARY KEY("tenant_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "app_versions" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "app_versions_tenant_id_app_id_version_pk" PRIMARY KEY("tenant_id","app_id","version")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"published_schema_version" integer DEFAULT 1 NOT NULL,
	"draft_schema_version" integer,
	"draft_status" "draft_status",
	CONSTRAINT "apps_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "apps_tenant_id_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "apps_draft_pair" CHECK (("apps"."draft_schema_version" is null) = ("apps"."draft_status" is null))
);
--> statement-breakpoint
CREATE TABLE "fields" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"field_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"introduced_in" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "field_type" NOT NULL,
	CONSTRAINT "fields_tenant_id_app_id_field_id_pk" PRIMARY KEY("tenant_id","app_id","field_id"),
	CONSTRAINT "fields_tenant_id_app_id_code_unique" UNIQUE("tenant_id","app_id","code")
);
--> statement-breakpoint
CREATE TABLE "record_references" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"target_app_id" uuid NOT NULL,
	"target_record_id" uuid NOT NULL,
	CONSTRAINT "record_references_tenant_id_app_id_record_id_field_id_pk" PRIMARY KEY("tenant_id","app_id","record_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "records" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"record_no" bigint NOT NULL,
	"data" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "records_tenant_id_app_id_id_pk" PRIMARY KEY("tenant_id","app_id","id"),
	CONSTRAINT "records_tenant_id_app_id_record_no_unique" UNIQUE("tenant_id","app_id","record_no"),
	CONSTRAINT "records_data_object" CHECK (jsonb_typeof("records"."data") = 'object')
);
--> statement-breakpoint
CREATE TABLE "tenant_members" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "tenant_members_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	CONSTRAINT "users_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "users_tenant_id_email_unique" UNIQUE("tenant_id","email")
);
--> statement-breakpoint
ALTER TABLE "app_counters" ADD CONSTRAINT "app_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_counters" ADD CONSTRAINT "app_counters_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_tenant_id_created_by_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_tenant_id_app_id_introduced_in_app_versions_tenant_id_app_id_version_fk" FOREIGN KEY ("tenant_id","app_id","introduced_in") REFERENCES "public"."app_versions"("tenant_id","app_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_references" ADD CONSTRAINT "record_references_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_references" ADD CONSTRAINT "record_references_tenant_id_app_id_field_id_fields_tenant_id_app_id_field_id_fk" FOREIGN KEY ("tenant_id","app_id","field_id") REFERENCES "public"."fields"("tenant_id","app_id","field_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_references" ADD CONSTRAINT "record_references_tenant_id_app_id_record_id_records_tenant_id_app_id_id_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_references" ADD CONSTRAINT "record_references_target_fk" FOREIGN KEY ("tenant_id","target_app_id","target_record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_tenant_id_app_id_schema_version_app_versions_tenant_id_app_id_version_fk" FOREIGN KEY ("tenant_id","app_id","schema_version") REFERENCES "public"."app_versions"("tenant_id","app_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_tenant_id_created_by_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_tenant_id_updated_by_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_tenant_id_deleted_by_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","deleted_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE apps
  ADD CONSTRAINT apps_published_version_fk
  FOREIGN KEY (tenant_id, id, published_schema_version)
  REFERENCES app_versions (tenant_id, app_id, version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE apps
  ADD CONSTRAINT apps_draft_version_fk
  FOREIGN KEY (tenant_id, id, draft_schema_version)
  REFERENCES app_versions (tenant_id, app_id, version) DEFERRABLE INITIALLY DEFERRED;
