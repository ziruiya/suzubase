ALTER TABLE "files" ADD COLUMN "purged_at" timestamp with time zone;
--> statement-breakpoint
GRANT UPDATE (purged_at) ON files TO suzubase_runtime;
CREATE FUNCTION authentication.maintenance_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT id FROM public.tenants $$;
REVOKE ALL ON FUNCTION authentication.maintenance_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authentication.maintenance_tenants() TO suzubase_runtime;
