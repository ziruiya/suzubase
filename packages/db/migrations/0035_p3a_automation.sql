ALTER TABLE record_events ADD COLUMN snapshot_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE outbox
  ADD COLUMN root_causation_id uuid,
  ADD COLUMN parent_run_id uuid,
  ADD COLUMN causation_depth integer NOT NULL DEFAULT 0,
  ADD COLUMN origin_rule_id uuid,
  ADD COLUMN origin_action_id uuid,
  ADD COLUMN automation_processed_at timestamptz,
  ADD CONSTRAINT outbox_causation_depth_nonnegative CHECK (causation_depth >= 0);

CREATE TABLE automation_rules (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  current_version integer,
  enabled boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id, id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES apps(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_members(tenant_id, user_id)
);
CREATE INDEX automation_rules_app_idx ON automation_rules(tenant_id, app_id, enabled);

CREATE TABLE automation_rule_versions (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  source_schema_version integer NOT NULL DEFAULT 1 CHECK (source_schema_version > 0),
  trigger_json jsonb NOT NULL,
  condition_json jsonb NOT NULL,
  actions_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  published_at timestamptz,
  PRIMARY KEY (tenant_id, rule_id, version),
  UNIQUE (tenant_id, app_id, rule_id, version),
  FOREIGN KEY (tenant_id, app_id, rule_id) REFERENCES automation_rules(tenant_id, app_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_members(tenant_id, user_id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES tenant_members(tenant_id, user_id)
);

CREATE OR REPLACE FUNCTION prevent_published_automation_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published automation versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER automation_published_version_immutable
  BEFORE UPDATE OR DELETE ON automation_rule_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_published_automation_version_mutation();
ALTER TABLE automation_rules ADD CONSTRAINT automation_current_version_fk
  FOREIGN KEY (tenant_id, id, current_version)
  REFERENCES automation_rule_versions(tenant_id, rule_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE automation_grants (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  rule_version integer NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_app_id uuid NOT NULL,
  readable_field_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(readable_field_ids) = 'array'),
  target_app_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(target_app_ids) = 'array'),
  writable_field_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(writable_field_ids) = 'array'),
  allowed_operations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_operations) = 'array'),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, rule_id, rule_version),
  FOREIGN KEY (tenant_id, app_id, rule_id, rule_version)
    REFERENCES automation_rule_versions(tenant_id, app_id, rule_id, version),
  FOREIGN KEY (tenant_id, source_app_id) REFERENCES apps(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES tenant_members(tenant_id, user_id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES tenant_members(tenant_id, user_id)
);

CREATE TABLE automation_runs (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL,
  rule_version integer NOT NULL,
  event_id uuid NOT NULL,
  trigger_identity text NOT NULL,
  idempotency_key text NOT NULL,
  record_id uuid NOT NULL,
  batch_id uuid,
  root_causation_id uuid NOT NULL,
  parent_run_id uuid,
  causation_depth integer NOT NULL CHECK (causation_depth >= 1),
  origin_rule_id uuid,
  origin_action_id uuid,
  status text NOT NULL CHECK (status IN (
    'QUEUED','RUNNING','SUCCEEDED','FAILED','SKIPPED_CONDITION','SKIPPED_STALE',
    'SKIPPED_UNAUTHORIZED','BLOCKED_CYCLE','POTENTIAL_CYCLE','CHAIN_DEPTH_EXCEEDED',
    'ACTIONS_NOT_IMPLEMENTED'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, app_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, app_id, rule_id, rule_version)
    REFERENCES automation_rule_versions(tenant_id, app_id, rule_id, version),
  FOREIGN KEY (tenant_id, app_id, event_id) REFERENCES outbox(tenant_id, app_id, event_id),
  FOREIGN KEY (tenant_id, app_id, record_id) REFERENCES records(tenant_id, app_id, id),
  FOREIGN KEY (tenant_id, parent_run_id) REFERENCES automation_runs(tenant_id, id)
);
CREATE INDEX automation_runs_history_idx ON automation_runs(tenant_id, app_id, rule_id, started_at DESC);
ALTER TABLE outbox ADD CONSTRAINT outbox_automation_parent_run_fk
  FOREIGN KEY (tenant_id, parent_run_id) REFERENCES automation_runs(tenant_id, id);

CREATE TABLE automation_run_actions (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  run_id uuid NOT NULL,
  action_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  status text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED','NOT_EXECUTED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  idempotency_key text NOT NULL,
  result_ref text,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, app_id, run_id, action_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, app_id, run_id) REFERENCES automation_runs(tenant_id, app_id, id)
);

CREATE TABLE automation_schedules (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL,
  rule_version integer NOT NULL,
  record_id uuid NOT NULL,
  schedule_key text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  invalidated_at timestamptz,
  invalidation_reason text,
  PRIMARY KEY (tenant_id, app_id, id),
  UNIQUE (tenant_id, rule_id, rule_version, record_id, schedule_key),
  FOREIGN KEY (tenant_id, app_id, rule_id, rule_version)
    REFERENCES automation_rule_versions(tenant_id, app_id, rule_id, version),
  FOREIGN KEY (tenant_id, app_id, record_id) REFERENCES records(tenant_id, app_id, id)
);

CREATE TABLE automation_webhook_deliveries (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  action_id uuid NOT NULL,
  delivery_id uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint_id uuid,
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature_version text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  response_status integer,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING','SUCCEEDED','RETRY_SCHEDULED','DELIVERY_UNCERTAIN','PERMANENT_FAILED','MANUAL_REVIEW_REQUIRED'
  )),
  error_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id, id),
  UNIQUE (tenant_id, delivery_id),
  FOREIGN KEY (tenant_id, app_id, run_id, action_id)
    REFERENCES automation_run_actions(tenant_id, app_id, run_id, action_id)
);

CREATE TABLE automation_audit_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  rule_version integer,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('RULE_CREATED','RULE_UPDATED','GRANT_APPROVED','GRANT_REVOKED','PREFLIGHT','PUBLISHED','ENABLED','DISABLED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, app_id, rule_id) REFERENCES automation_rules(tenant_id, app_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES tenant_members(tenant_id, user_id)
);
CREATE INDEX automation_audit_rule_idx ON automation_audit_events(tenant_id, rule_id, occurred_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'automation_rules','automation_rule_versions','automation_grants','automation_runs',
    'automation_run_actions','automation_schedules','automation_webhook_deliveries','automation_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I TO suzubase_runtime USING (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO suzubase_runtime', table_name);
  END LOOP;
END $$;
GRANT UPDATE (snapshot_data) ON record_events TO suzubase_runtime;
GRANT UPDATE (root_causation_id, parent_run_id, causation_depth, origin_rule_id, origin_action_id, automation_processed_at) ON outbox TO suzubase_runtime;
