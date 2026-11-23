-- P3-B: real action execution foundations.
-- Manual runs (T-4) have no originating outbox event.
ALTER TABLE automation_runs ALTER COLUMN event_id DROP NOT NULL;

-- A-4: workflow actions opt in to automation explicitly.
ALTER TABLE workflow_actions ADD COLUMN automation_allowed boolean NOT NULL DEFAULT false;

-- A-4 attribution: workflow events record automation actor, rule and run.
ALTER TABLE workflow_events ADD COLUMN actor_type text NOT NULL DEFAULT 'USER';
ALTER TABLE workflow_events ADD CONSTRAINT workflow_events_actor_type_check
  CHECK (actor_type IN ('USER','AUTOMATION'));
ALTER TABLE workflow_events ADD COLUMN rule_id uuid;
ALTER TABLE workflow_events ADD COLUMN run_id uuid;

ALTER TABLE automation_audit_events DROP CONSTRAINT automation_audit_events_action_check;
ALTER TABLE automation_audit_events ADD CONSTRAINT automation_audit_events_action_check
  CHECK (action IN (
    'RULE_CREATED','RULE_UPDATED','RULE_ARCHIVED','GRANT_APPROVED','GRANT_REVOKED',
    'PREFLIGHT','PUBLISHED','ENABLED','DISABLED',
    'RATE_LIMITED','BACKLOG_LIMITED','CHAIN_PAUSED','CHAIN_RESUMED',
    'MANUAL_RUN','RUN_RETRIED','RUN_HISTORY_PRUNED'
  ));
