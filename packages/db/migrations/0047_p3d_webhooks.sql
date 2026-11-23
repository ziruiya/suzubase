-- P3-D wave 1 (Webhook, A-5): endpoint configurations, the delivery
-- columns the worker needs, and one row per delivery attempt.
--
-- Endpoints are referenced from rule actions (actions_json webhook
-- .endpointId). Signing secrets are stored AES-256-GCM encrypted by the
-- API (never plaintext, never returned). An endpoint URL change clears
-- validated_url_hash: deliveries refuse to run until an administrator
-- re-validates the endpoint (POST .../webhook-endpoints/:id/validate).

CREATE TABLE automation_webhook_endpoints (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  policy text NOT NULL CHECK (policy IN ('AUTO_RETRY_AT_LEAST_ONCE','MANUAL_ON_UNCERTAIN')),
  secret_enc text NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  previous_secret_enc text,
  previous_key_version integer,
  rotated_at timestamptz,
  validated_url_hash text,
  validated_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id, id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES apps(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_members(tenant_id, user_id)
);
CREATE INDEX automation_webhook_endpoints_app_idx
  ON automation_webhook_endpoints(tenant_id, app_id, created_at);

-- The P3-A stub delivery table gains: the frozen payload (built from the
-- event snapshot at enqueue time; delivery never re-reads live business
-- values), the endpoint snapshot, a worker claim lease, and the stable
-- (run, action) idempotency key -- one delivery per logical action.
ALTER TABLE automation_webhook_deliveries ADD COLUMN endpoint_url text;
ALTER TABLE automation_webhook_deliveries ADD COLUMN policy text;
ALTER TABLE automation_webhook_deliveries ADD COLUMN key_version integer;
ALTER TABLE automation_webhook_deliveries ADD COLUMN payload jsonb;
ALTER TABLE automation_webhook_deliveries ADD COLUMN payload_hash text;
ALTER TABLE automation_webhook_deliveries ADD COLUMN claim_token uuid;
ALTER TABLE automation_webhook_deliveries ADD COLUMN claimed_at timestamptz;
ALTER TABLE automation_webhook_deliveries ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE automation_webhook_deliveries
  ADD CONSTRAINT automation_webhook_deliveries_run_action_unique UNIQUE (tenant_id, run_id, action_id);
ALTER TABLE automation_webhook_deliveries
  ADD FOREIGN KEY (tenant_id, app_id, endpoint_id)
  REFERENCES automation_webhook_endpoints(tenant_id, app_id, id);
CREATE INDEX automation_webhook_deliveries_due_idx
  ON automation_webhook_deliveries(tenant_id, next_attempt_at)
  WHERE status IN ('PENDING','RETRY_SCHEDULED','DELIVERY_UNCERTAIN');

CREATE TABLE automation_webhook_attempts (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  delivery_row_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  key_version integer,
  outcome text NOT NULL CHECK (outcome IN (
    'SUCCEEDED','RETRYABLE_FAILURE','UNCERTAIN','PERMANENT_FAILURE','BLOCKED'
  )),
  http_status integer,
  error_type text,
  response_summary text,
  response_bytes integer,
  response_hash text,
  pinned_ip text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, app_id, id),
  UNIQUE (tenant_id, delivery_row_id, attempt_number),
  FOREIGN KEY (tenant_id, app_id, delivery_row_id)
    REFERENCES automation_webhook_deliveries(tenant_id, app_id, id)
);
CREATE INDEX automation_webhook_attempts_delivery_idx
  ON automation_webhook_attempts(tenant_id, delivery_row_id, attempt_number);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['automation_webhook_endpoints','automation_webhook_attempts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I TO suzubase_runtime USING (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO suzubase_runtime', table_name);
  END LOOP;
END $$;

-- Manual resend of a webhook delivery is an auditable operator action.
ALTER TABLE automation_audit_events DROP CONSTRAINT automation_audit_events_action_check;
ALTER TABLE automation_audit_events ADD CONSTRAINT automation_audit_events_action_check
  CHECK (action IN (
    'RULE_CREATED','RULE_UPDATED','RULE_ARCHIVED','GRANT_APPROVED','GRANT_REVOKED',
    'PREFLIGHT','PUBLISHED','ENABLED','DISABLED',
    'RATE_LIMITED','BACKLOG_LIMITED','CHAIN_PAUSED','CHAIN_RESUMED',
    'MANUAL_RUN','RUN_RETRIED','RUN_HISTORY_PRUNED','SCHEDULE_BACKLOG_ALERT',
    'SCHEDULE_MISSED_ALERT','WEBHOOK_DELIVERY_RESEND'
  ));
