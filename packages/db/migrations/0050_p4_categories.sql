-- P4-T1 categories: the category tree lives in the versioned
-- app_versions.category_configuration JSONB (same draft/publish lifecycle
-- as views/ACL/notification rules); record assignments live in the new
-- record_categories link table (identity = category node id, never name).
ALTER TABLE "app_versions" ADD COLUMN "category_configuration" jsonb DEFAULT '{"enabled":false,"nodes":[]}'::jsonb NOT NULL;
--> statement-breakpoint
GRANT UPDATE (category_configuration) ON app_versions TO suzubase_runtime;
--> statement-breakpoint
CREATE TABLE "record_categories" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "record_categories_tenant_id_app_id_record_id_category_id_pk" PRIMARY KEY("tenant_id","app_id","record_id","category_id")
);
--> statement-breakpoint
CREATE INDEX "record_categories_category_idx" ON "record_categories" USING btree ("tenant_id","app_id","category_id");
--> statement-breakpoint
ALTER TABLE "record_categories" ADD CONSTRAINT "record_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "record_categories" ADD CONSTRAINT "record_categories_app_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "record_categories" ADD CONSTRAINT "record_categories_record_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE record_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON record_categories TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON record_categories TO suzubase_runtime;
--> statement-breakpoint
-- Import cleanup completeness: purge_imported_app (0048 definition)
-- recreated with record_categories deleted before its parent records.
-- Everything else is byte-identical to the 0048 definition.
CREATE OR REPLACE FUNCTION public.purge_imported_app(p_tenant_id uuid, p_app_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $purge$
DECLARE
  v_records int; v_comments int; v_events int; v_files int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM apps WHERE tenant_id = p_tenant_id AND id = p_app_id
    AND activation_state = 'import-pending') THEN
    RETURN jsonb_build_object('purged', false, 'reason', 'application is not import-pending');
  END IF;
  SELECT count(*) INTO v_records FROM records WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  SELECT count(*) INTO v_comments FROM record_comments WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  SELECT count(*) INTO v_events FROM record_events WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  SELECT count(*) INTO v_files FROM files WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_webhook_attempts WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_webhook_deliveries WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_run_actions WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_problem_chains WHERE tenant_id = p_tenant_id
    AND last_run_id IN (SELECT id FROM automation_runs WHERE tenant_id = p_tenant_id AND app_id = p_app_id);
  DELETE FROM automation_runs WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_audit_events WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_grants WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_schedules WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_cadence_slots WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_cadence_plans WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_date_backfills WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_rule_versions WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_rules WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM automation_webhook_endpoints WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM permission_audit WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_create_keys WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM notifications WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM outbox WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_search_values WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_unique_values WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM file_references WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM comment_mentions WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_comments WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM workflow_events WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_events WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM workflow_assignments WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_workflow_state WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_references WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_categories WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM record_table_rows WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM records WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM files WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM workflow_actions WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM workflow_states WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM workflow_definitions WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM issued_auto_numbers WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM auto_number_counters WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM app_counters WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM fields WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM app_versions WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM authentication.api_tokens WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM export_jobs WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
  DELETE FROM apps WHERE tenant_id = p_tenant_id AND id = p_app_id;
  RETURN jsonb_build_object('purged', true, 'records', v_records, 'comments', v_comments,
    'historyEvents', v_events, 'attachments', v_files);
END $purge$;
