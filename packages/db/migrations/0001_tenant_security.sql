DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'tenants', 'users', 'tenant_members', 'apps', 'app_versions',
    'fields', 'app_counters', 'records', 'record_references'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON public.%I TO suzubase_runtime USING (%I = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid)',
      tenant_table,
      CASE WHEN tenant_table = 'tenants' THEN 'id' ELSE 'tenant_id' END
    );
    EXECUTE format('GRANT SELECT ON public.%I TO suzubase_runtime', tenant_table);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT INSERT ON apps, app_versions, fields, app_counters, records, record_references TO suzubase_runtime;
--> statement-breakpoint
GRANT UPDATE (draft_schema_version, draft_status, published_schema_version) ON apps TO suzubase_runtime;
--> statement-breakpoint
GRANT UPDATE (last_value) ON app_counters TO suzubase_runtime;
--> statement-breakpoint
GRANT UPDATE (data, revision, updated_at, updated_by) ON records TO suzubase_runtime;
