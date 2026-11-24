-- Public sample site: designates one tenant and one of its members as the
-- publicly reachable sample workspace. The row is read before authentication
-- through a SECURITY DEFINER function (same pattern as verify_login); the
-- guest member never holds login credentials. The Turnstile secret is NOT
-- stored here -- it stays in the API process environment; only the public
-- site key lives in this table.
CREATE TABLE "authentication"."sample_site" (
	"tenant_id" uuid NOT NULL,
	"guest_user_id" uuid NOT NULL,
	"site_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "sample_site_tenant_id_pk" PRIMARY KEY("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "authentication"."sample_site" ADD CONSTRAINT "sample_site_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "authentication"."sample_site" ADD CONSTRAINT "sample_site_tenant_id_guest_user_id_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","guest_user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE authentication.sample_site ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION authentication.sample_site()
RETURNS TABLE (tenant_id uuid, guest_user_id uuid, site_key text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.tenant_id, s.guest_user_id, s.site_key
  FROM authentication.sample_site s
  WHERE s.enabled
  ORDER BY s.tenant_id
  LIMIT 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authentication.sample_site() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authentication.sample_site() TO suzubase_runtime;
