ALTER TABLE automation_audit_events DROP CONSTRAINT automation_audit_events_action_check;
ALTER TABLE automation_audit_events ADD CONSTRAINT automation_audit_events_action_check
  CHECK (action IN (
    'RULE_CREATED','RULE_UPDATED','RULE_ARCHIVED','GRANT_APPROVED','GRANT_REVOKED',
    'PREFLIGHT','PUBLISHED','ENABLED','DISABLED'
  ));
