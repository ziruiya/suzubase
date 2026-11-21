CREATE SCHEMA "authentication";
--> statement-breakpoint
CREATE TABLE "authentication"."login_credentials" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	CONSTRAINT "login_credentials_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "login_credentials_tenant_id_email_unique" UNIQUE("tenant_id","email")
);
--> statement-breakpoint
ALTER TABLE "tenant_members" ADD COLUMN "can_create_apps" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication"."login_credentials" ADD CONSTRAINT "login_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication"."login_credentials" ADD CONSTRAINT "login_credentials_tenant_id_user_id_tenant_members_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_credentials_email_index" ON "authentication"."login_credentials" USING btree ("email");
--> statement-breakpoint
CREATE EXTENSION pgcrypto WITH SCHEMA authentication;
--> statement-breakpoint
ALTER TABLE authentication.login_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION authentication.verify_login(login_email text, login_password text)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH matches AS MATERIALIZED (
    SELECT c.tenant_id, c.user_id
    FROM authentication.login_credentials c
    WHERE c.email = login_email
      AND c.password_hash = authentication.crypt(
        encode(authentication.digest(login_password, 'sha256'), 'hex'), c.password_hash
      )
    LIMIT 2
  )
  SELECT m.tenant_id, m.user_id FROM matches m
  WHERE (SELECT count(*) FROM matches) = 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authentication.verify_login(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA authentication TO suzubase_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authentication.verify_login(text, text) TO suzubase_runtime;
