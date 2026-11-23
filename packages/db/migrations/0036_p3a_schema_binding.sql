CREATE OR REPLACE FUNCTION prevent_automation_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'automation audit events are append-only';
END
$$;
CREATE TRIGGER automation_audit_append_only
  BEFORE UPDATE OR DELETE ON automation_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_automation_audit_mutation();
REVOKE UPDATE, DELETE ON automation_audit_events FROM suzubase_runtime;
