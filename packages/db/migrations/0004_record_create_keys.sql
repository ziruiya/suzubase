CREATE TABLE "record_create_keys" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"record_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	CONSTRAINT "record_create_keys_tenant_id_app_id_user_id_key_pk" PRIMARY KEY("tenant_id","app_id","user_id","key")
);
--> statement-breakpoint
ALTER TABLE "record_create_keys" ADD CONSTRAINT "record_create_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_create_keys" ADD CONSTRAINT "record_create_keys_tenant_id_app_id_record_id_records_tenant_id_app_id_id_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_create_keys" ADD CONSTRAINT "record_create_keys_tenant_id_user_id_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE record_create_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_scope ON record_create_keys TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON record_create_keys TO suzubase_runtime;
