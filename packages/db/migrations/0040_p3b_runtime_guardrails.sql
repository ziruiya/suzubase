ALTER TABLE automation_runs DROP CONSTRAINT automation_runs_status_check;
ALTER TABLE automation_runs ADD CONSTRAINT automation_run_status CHECK (status IN (
  'QUEUED','RUNNING','SUCCEEDED','FAILED','SKIPPED_CONDITION','SKIPPED_STALE',
  'SKIPPED_UNAUTHORIZED','BLOCKED_CYCLE','CHAIN_DEPTH_EXCEEDED','ACTIONS_NOT_IMPLEMENTED',
  'RATE_LIMITED','BACKLOG_LIMITED','CHAIN_PAUSED'
));

ALTER TABLE automation_rule_versions DROP CONSTRAINT automation_rule_versions_status_check;
ALTER TABLE automation_rule_versions ADD CONSTRAINT automation_rule_versions_status_check
  CHECK (status IN ('draft','published'));

ALTER TABLE automation_schedules ADD CONSTRAINT automation_schedules_status_check
  CHECK (status IN (
    'PENDING','SCHEDULED','SUCCEEDED','FAILED','INVALIDATED','SKIPPED_NONEXISTENT_TIME','MISSED','LATE','CANCELLED'
  ));

ALTER TABLE automation_audit_events DROP CONSTRAINT automation_audit_events_action_check;
ALTER TABLE automation_audit_events ADD CONSTRAINT automation_audit_events_action_check
  CHECK (action IN (
    'RULE_CREATED','RULE_UPDATED','RULE_ARCHIVED','GRANT_APPROVED','GRANT_REVOKED',
    'PREFLIGHT','PUBLISHED','ENABLED','DISABLED',
    'RATE_LIMITED','BACKLOG_LIMITED','CHAIN_PAUSED','CHAIN_RESUMED'
  ));

CREATE TABLE automation_problem_chains (
  tenant_id uuid NOT NULL,
  root_causation_id uuid NOT NULL,
  reason text NOT NULL,
  last_run_id uuid,
  paused_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz,
  resumed_by uuid,
  PRIMARY KEY (tenant_id, root_causation_id),
  FOREIGN KEY (tenant_id, last_run_id) REFERENCES automation_runs(tenant_id, id),
  FOREIGN KEY (tenant_id, resumed_by) REFERENCES tenant_members(tenant_id, user_id)
);

CREATE INDEX automation_problem_chains_active_idx
  ON automation_problem_chains(tenant_id, paused_at DESC)
  WHERE resumed_at IS NULL;

ALTER TABLE automation_problem_chains ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON automation_problem_chains
  TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_problem_chains TO suzubase_runtime;
