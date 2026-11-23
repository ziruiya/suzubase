-- P3-C (fixed cadence, T-3 upper half): persistent cadence plans and
-- per-slot execution records for schedule.fixed triggers.
-- automation_schedules (P3-A) is the per-record plan table used by the
-- date-relative wave (its record_id is NOT NULL); fixed-cadence plans are
-- per rule version, so they get their own tables instead of bending that
-- contract. Slot rows are the durable per-period identity: one row per
-- (rule version, slot key), which is what makes duplicate scans, crash
-- recovery and DST/missed dispositions auditable.

CREATE TABLE automation_cadence_plans (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL,
  rule_version integer NOT NULL,
  timezone text NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  local_time text NOT NULL,
  weekdays jsonb,
  month_day integer,
  missed_run_policy text NOT NULL DEFAULT 'skip' CHECK (missed_run_policy IN ('skip','catch_up_latest')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INVALIDATED')),
  invalidation_reason text,
  next_due_at timestamptz NOT NULL,
  next_slot_key text NOT NULL,
  last_completed_slot text,
  claim_token uuid,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id, id),
  UNIQUE (tenant_id, rule_id, rule_version),
  FOREIGN KEY (tenant_id, app_id, rule_id, rule_version)
    REFERENCES automation_rule_versions(tenant_id, app_id, rule_id, version)
);
CREATE INDEX automation_cadence_plans_due_idx
  ON automation_cadence_plans(tenant_id, next_due_at)
  WHERE status = 'ACTIVE';

CREATE TABLE automation_cadence_slots (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  rule_version integer NOT NULL,
  slot_key text NOT NULL,
  local_date text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  is_catchup boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'CLAIMED' CHECK (status IN (
    'CLAIMED','COMPLETED','SKIPPED_NONEXISTENT_TIME','SKIPPED_MISSED','FAILED'
  )),
  batch_id uuid,
  claim_token uuid,
  cursor_record_id uuid,
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, app_id, id),
  UNIQUE (tenant_id, rule_id, rule_version, slot_key),
  FOREIGN KEY (tenant_id, app_id, plan_id)
    REFERENCES automation_cadence_plans(tenant_id, app_id, id),
  FOREIGN KEY (tenant_id, app_id, rule_id, rule_version)
    REFERENCES automation_rule_versions(tenant_id, app_id, rule_id, version)
);
CREATE INDEX automation_cadence_slots_plan_idx
  ON automation_cadence_slots(tenant_id, plan_id, created_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['automation_cadence_plans','automation_cadence_slots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I TO suzubase_runtime USING (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO suzubase_runtime', table_name);
  END LOOP;
END $$;

-- Schedule backlog alerts are SYSTEM audit-visible events.
ALTER TABLE automation_audit_events DROP CONSTRAINT automation_audit_events_action_check;
ALTER TABLE automation_audit_events ADD CONSTRAINT automation_audit_events_action_check
  CHECK (action IN (
    'RULE_CREATED','RULE_UPDATED','RULE_ARCHIVED','GRANT_APPROVED','GRANT_REVOKED',
    'PREFLIGHT','PUBLISHED','ENABLED','DISABLED',
    'RATE_LIMITED','BACKLOG_LIMITED','CHAIN_PAUSED','CHAIN_RESUMED',
    'MANUAL_RUN','RUN_RETRIED','RUN_HISTORY_PRUNED','SCHEDULE_BACKLOG_ALERT'
  ));
