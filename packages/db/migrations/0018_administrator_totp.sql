ALTER TABLE "authentication"."login_credentials" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "authentication"."login_credentials" ADD COLUMN "totp_pending_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "authentication"."login_credentials" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "authentication"."login_credentials" ADD COLUMN "totp_recovery_hashes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication"."login_credentials" ADD COLUMN "totp_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "authentication"."login_credentials" ADD COLUMN "totp_retry_after" timestamp with time zone;
--> statement-breakpoint
GRANT SELECT (totp_secret, totp_pending_until, totp_last_step, totp_recovery_hashes, totp_failures, totp_retry_after),
      UPDATE (totp_secret, totp_pending_until, totp_last_step, totp_recovery_hashes, totp_failures, totp_retry_after)
  ON authentication.login_credentials TO suzubase_runtime;
