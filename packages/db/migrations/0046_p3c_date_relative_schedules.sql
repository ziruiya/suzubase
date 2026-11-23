-- P3-C (date-relative, T-3 lower half): consume the P3-A
-- automation_schedules table. Adds the columns the date-relative worker
-- needs -- the source date a plan was computed from (execution-time
-- staleness check), an atomic claim lease (same pattern as cadence
-- plans) and the execution timestamp -- plus the backfill checkpoint
-- table used when a date-relative rule is published/enabled against an
-- application that already holds records.

ALTER TABLE automation_schedules ADD COLUMN source_date text;
ALTER TABLE automation_schedules ADD COLUMN claim_token uuid;
ALTER TABLE automation_schedules ADD COLUMN claimed_at timestamptz;
ALTER TABLE automation_schedules ADD COLUMN executed_at timestamptz;

CREATE INDEX automation_schedules_due_idx
  ON automation_schedules(tenant_id, due_at)
  WHERE status = 'PENDING';

CREATE TABLE automation_date_backfills (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL,
  rule_version integer NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED')),
  cursor_record_id uuid,
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id, id),
  UNIQUE (tenant_id, rule_id, rule_version),
  FOREIGN KEY (tenant_id, app_id, rule_id, rule_version)
    REFERENCES automation_rule_versions(tenant_id, app_id, rule_id, version)
);
CREATE INDEX automation_date_backfills_status_idx
  ON automation_date_backfills(tenant_id, status)
  WHERE status = 'RUNNING';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['automation_date_backfills'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I TO suzubase_runtime USING (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO suzubase_runtime', table_name);
  END LOOP;
END $$;

-- Aggregated MISSED alerts for date-relative plans are SYSTEM
-- audit-visible events (same pattern as SCHEDULE_BACKLOG_ALERT).
ALTER TABLE automation_audit_events DROP CONSTRAINT automation_audit_events_action_check;
ALTER TABLE automation_audit_events ADD CONSTRAINT automation_audit_events_action_check
  CHECK (action IN (
    'RULE_CREATED','RULE_UPDATED','RULE_ARCHIVED','GRANT_APPROVED','GRANT_REVOKED',
    'PREFLIGHT','PUBLISHED','ENABLED','DISABLED',
    'RATE_LIMITED','BACKLOG_LIMITED','CHAIN_PAUSED','CHAIN_RESUMED',
    'MANUAL_RUN','RUN_RETRIED','RUN_HISTORY_PRUNED','SCHEDULE_BACKLOG_ALERT',
    'SCHEDULE_MISSED_ALERT'
  ));
