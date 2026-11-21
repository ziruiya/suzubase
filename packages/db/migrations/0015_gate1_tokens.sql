CREATE TABLE "authentication"."api_tokens" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"issued_by" uuid NOT NULL,
	"label" text NOT NULL,
	"secret_hash" text NOT NULL,
	"actions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_tenant_id_app_id_id_pk" PRIMARY KEY("tenant_id","app_id","id"),
	CONSTRAINT "api_tokens_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "authentication"."api_tokens" ADD CONSTRAINT "api_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication"."api_tokens" ADD CONSTRAINT "api_tokens_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication"."api_tokens" ADD CONSTRAINT "api_tokens_tenant_id_issued_by_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","issued_by") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE authentication.api_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON authentication.api_tokens TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT (tenant_id, app_id, id, issued_by, label, actions, created_at, revoked_at),
  INSERT, UPDATE (revoked_at) ON authentication.api_tokens TO suzubase_runtime;
--> statement-breakpoint
CREATE FUNCTION authentication.verify_api_token(lookup_hash text)
RETURNS TABLE (tenant_id uuid, user_id uuid, app_id uuid, actions jsonb)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.tenant_id, a.issued_by, a.app_id, a.actions
  FROM authentication.api_tokens a
  JOIN public.tenant_members m ON m.tenant_id = a.tenant_id AND m.user_id = a.issued_by
  JOIN public.apps ap ON ap.tenant_id = a.tenant_id AND ap.id = a.app_id
  WHERE a.secret_hash = lookup_hash AND a.revoked_at IS NULL AND m.disabled_at IS NULL AND ap.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION authentication.verify_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authentication.verify_api_token(text) TO suzubase_runtime;
