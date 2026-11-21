ALTER TABLE "apps" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "theme_color" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "title_field_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "duplicate_hint" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "numeric_precision" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "admin_memo" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD COLUMN "can_manage_recycle_bin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
GRANT UPDATE (name, description, icon, theme_color, title_field_id, duplicate_hint,
  numeric_precision, admin_memo, archived_at, deleted_at) ON apps TO suzubase_runtime;
GRANT UPDATE (can_manage_recycle_bin) ON tenant_members TO suzubase_runtime;
