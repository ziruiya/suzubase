CREATE TABLE "group_members" (
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "group_members_tenant_id_group_id_user_id_pk" PRIMARY KEY("tenant_id","group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "member_groups" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "member_groups_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	CONSTRAINT "organizations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "tenant_members" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "allow_app_creation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "password_minimum" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "password_complexity" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_group_id_member_groups_tenant_id_id_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."member_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_user_id_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_groups" ADD CONSTRAINT "member_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tenant_id_parent_id_organizations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."organizations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_organization_id_organizations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","organization_id") REFERENCES "public"."organizations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_login_name_unique" UNIQUE("tenant_id","login_name");
--> statement-breakpoint
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['organizations', 'member_groups', 'group_members']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON public.%I TO suzubase_runtime USING (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO suzubase_runtime', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT INSERT ON users, tenant_members TO suzubase_runtime;
GRANT UPDATE (display_name) ON users TO suzubase_runtime;
GRANT UPDATE (disabled_at, session_version, organization_id) ON tenant_members TO suzubase_runtime;
GRANT UPDATE (allow_app_creation, password_minimum, password_complexity) ON tenants TO suzubase_runtime;
CREATE POLICY tenant_scope ON authentication.login_credentials TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT INSERT, SELECT (tenant_id, user_id), UPDATE (password_hash)
  ON authentication.login_credentials TO suzubase_runtime;
--> statement-breakpoint
DROP FUNCTION authentication.verify_login(text, text);
CREATE FUNCTION authentication.verify_login(login_identifier text, login_password text)
RETURNS TABLE (tenant_id uuid, user_id uuid, session_version integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH matches AS MATERIALIZED (
    SELECT c.tenant_id, c.user_id, m.session_version
    FROM authentication.login_credentials c
    JOIN public.tenant_members m USING (tenant_id, user_id)
    JOIN public.users u ON u.tenant_id = c.tenant_id AND u.id = c.user_id
    WHERE (c.email = login_identifier OR u.login_name = login_identifier)
      AND m.disabled_at IS NULL
      AND c.password_hash = authentication.crypt(
        encode(authentication.digest(login_password, 'sha256'), 'hex'), c.password_hash
      )
    LIMIT 2
  )
  SELECT m.tenant_id, m.user_id, m.session_version FROM matches m
  WHERE (SELECT count(*) FROM matches) = 1;
$$;
REVOKE ALL ON FUNCTION authentication.verify_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authentication.verify_login(text, text) TO suzubase_runtime;
