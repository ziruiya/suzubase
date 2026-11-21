-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION authentication.verify_login(login_identifier text, login_password text)
RETURNS TABLE (tenant_id uuid, user_id uuid, session_version integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH candidates AS MATERIALIZED (
    SELECT c.tenant_id, c.user_id, c.password_hash, m.session_version
    FROM authentication.login_credentials c
    JOIN public.tenant_members m USING (tenant_id, user_id)
    JOIN public.users u ON u.tenant_id = c.tenant_id AND u.id = c.user_id
    WHERE m.disabled_at IS NULL AND (c.email = login_identifier OR u.login_name = login_identifier)
  ), matches AS MATERIALIZED (
    SELECT c.tenant_id, c.user_id, c.session_version FROM candidates c
    WHERE c.password_hash = authentication.crypt(
      encode(authentication.digest(login_password, 'sha256'), 'hex'), c.password_hash
    )
    LIMIT 2
  )
  SELECT m.tenant_id, m.user_id, m.session_version FROM matches m
  WHERE (SELECT count(*) FROM matches) = 1;
$$;
