-- P3-D wave 2 (M1 automation export/import): webhook endpoints imported
-- from an M1 package are credential placeholders. The package never
-- carries secret material (neither plaintext nor the AES-256-GCM
-- ciphertext), so an imported endpoint is created with an empty
-- secret_enc and credential_pending = true. While the flag is set the
-- endpoint cannot be delivered to: publish preflight blocks with
-- WEBHOOK_CREDENTIAL_REQUIRED, the run action fails closed with the
-- same code, and the delivery worker refuses the attempt. Supplying a
-- secret through the existing rotate-secret route clears the flag.

ALTER TABLE automation_webhook_endpoints
  ADD COLUMN credential_pending boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Import cleanup completeness: purge_imported_app (migration 0033) did
-- not know the automation tables, so cancelling or failing an import
-- that staged automation rules would have been blocked by foreign keys
-- from automation_rules to apps. The function is recreated with the
-- automation tables deleted first, in dependency order. Everything else
-- is byte-identical to the 0033 definition.
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
