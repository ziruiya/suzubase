CREATE TABLE "permission_audit" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"record_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_audit_tenant_id_app_id_id_pk" PRIMARY KEY("tenant_id","app_id","id")
);
--> statement-breakpoint
ALTER TABLE "app_versions" ADD COLUMN "acl_configuration" jsonb DEFAULT '{"app":[],"record":[],"field":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_tenant_id_actor_id_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","actor_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_tenant_id_target_user_id_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","target_user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE permission_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON permission_audit TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT INSERT ON permission_audit TO suzubase_runtime;
GRANT UPDATE (acl_configuration) ON app_versions TO suzubase_runtime;
