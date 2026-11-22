-- SuzuBase post-restore ownership normalization (G3-13).
--
-- A pg_dump/pg_restore cycle recreates every object owned by the restoring
-- (bootstrap/admin) role, while a fresh deployment's objects are owned by
-- the least-privilege migration role (suzubase_migration) — the role the
-- migrator connects as. Without this step the restored deployment cannot
-- apply future migrations ("permission denied for schema drizzle", 42501).
-- Run as the bootstrap/admin role AFTER every restore, BEFORE starting the
-- application stack. Extensions and system objects are intentionally not
-- touched (they stay with the bootstrap role, as in a fresh deployment).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schema_name FROM information_schema.schemata
           WHERE schema_name IN ('public', 'drizzle', 'authentication') LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO suzubase_migration', r.schema_name);
  END LOOP;
  FOR r IN SELECT schemaname, tablename FROM pg_tables
           WHERE schemaname IN ('public', 'drizzle', 'authentication') LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO suzubase_migration', r.schemaname, r.tablename);
  END LOOP;
  FOR r IN SELECT schemaname, viewname FROM pg_views
           WHERE schemaname IN ('public', 'drizzle', 'authentication') LOOP
    EXECUTE format('ALTER VIEW %I.%I OWNER TO suzubase_migration', r.schemaname, r.viewname);
  END LOOP;
  FOR r IN SELECT sequence_schema, sequence_name FROM information_schema.sequences
           WHERE sequence_schema IN ('public', 'drizzle', 'authentication') LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO suzubase_migration', r.sequence_schema, r.sequence_name);
  END LOOP;
  FOR r IN SELECT n.nspname AS s, p.proname AS fn, pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('public', 'authentication') LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO suzubase_migration', r.s, r.fn, r.args);
  END LOOP;
  FOR r IN SELECT n.nspname AS s, t.typname AS tn FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE t.typtype = 'e' AND n.nspname IN ('public', 'authentication') LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO suzubase_migration', r.s, r.tn);
  END LOOP;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO suzubase_migration;
