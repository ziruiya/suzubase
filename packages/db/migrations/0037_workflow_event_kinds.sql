ALTER TABLE workflow_actions
  ADD COLUMN event_type text NOT NULL DEFAULT 'transitioned'
  CHECK (event_type IN ('transitioned','rejected'));
ALTER TABLE workflow_events
  ADD COLUMN event_type text NOT NULL DEFAULT 'transitioned'
  CHECK (event_type IN ('transitioned','rejected'));
GRANT SELECT ON workflow_actions, workflow_events TO suzubase_runtime;
GRANT INSERT ON workflow_events TO suzubase_runtime;
