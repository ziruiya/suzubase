-- P4-T2 subtable FILE: references from subtable row attachment cells to
-- files live in table_file_references (the child field id is not a row in
-- "fields", so file_references cannot address a cell). One attachment
-- subsystem: same files table, state machine, retention and counting.
-- P4 merge (p4-merge-t1t2): this migration was renumbered from index 50
-- to 51 (0050 is p4-t1-categories), and its purge_imported_app below is
-- the combined final definition: the 0048 body plus BOTH added DELETE
-- lines (table_file_references and record_categories).
CREATE TABLE "table_file_references" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"sub_field_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "table_file_references_pk" PRIMARY KEY("tenant_id","app_id","record_id","field_id","row_id","sub_field_id","file_id")
);
--> statement-breakpoint
CREATE INDEX "table_file_references_file_idx" ON "table_file_references" USING btree ("tenant_id","app_id","file_id");
--> statement-breakpoint
ALTER TABLE "table_file_references" ADD CONSTRAINT "table_file_references_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "table_file_references" ADD CONSTRAINT "table_file_references_app_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "table_file_references" ADD CONSTRAINT "table_file_references_record_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "table_file_references" ADD CONSTRAINT "table_file_references_field_fk" FOREIGN KEY ("tenant_id","app_id","field_id") REFERENCES "public"."fields"("tenant_id","app_id","field_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "table_file_references" ADD CONSTRAINT "table_file_references_file_fk" FOREIGN KEY ("tenant_id","app_id","file_id") REFERENCES "public"."files"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE table_file_references ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON table_file_references TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON table_file_references TO suzubase_runtime;
--> statement-breakpoint
-- Import cleanup completeness: purge_imported_app (0048 definition)
-- recreated with table_file_references deleted before its parent records
-- and record_categories deleted before its parent records (the 0050
-- categories migration added that line; this final definition carries
-- both). Everything else is byte-identical to the 0048 definition.
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
  DELETE FROM table_file_references WHERE tenant_id = p_tenant_id AND app_id = p_app_id;
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
