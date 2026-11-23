ALTER TABLE automation_rule_versions
  ADD CONSTRAINT automation_rule_source_schema_fk
  FOREIGN KEY (tenant_id, app_id, source_schema_version)
  REFERENCES app_versions(tenant_id, app_id, version);
