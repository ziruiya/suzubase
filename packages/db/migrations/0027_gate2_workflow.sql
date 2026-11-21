CREATE TABLE "record_workflow_state" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version" integer NOT NULL,
	"state_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "record_workflow_state_tenant_id_app_id_record_id_pk" PRIMARY KEY("tenant_id","app_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_actions" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"from_state_id" uuid NOT NULL,
	"to_state_id" uuid NOT NULL,
	"condition_expr" jsonb NOT NULL,
	"assignee_rule" jsonb NOT NULL,
	CONSTRAINT "workflow_actions_tenant_id_app_id_workflow_id_id_pk" PRIMARY KEY("tenant_id","app_id","workflow_id","id")
);
--> statement-breakpoint
CREATE TABLE "workflow_assignments" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "workflow_assignments_tenant_id_app_id_record_id_user_id_pk" PRIMARY KEY("tenant_id","app_id","record_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "workflow_definitions_tenant_id_app_id_id_pk" PRIMARY KEY("tenant_id","app_id","id"),
	CONSTRAINT "workflow_definitions_tenant_id_app_id_version_unique" UNIQUE("tenant_id","app_id","version"),
	CONSTRAINT "workflow_definitions_tenant_id_app_id_id_version_unique" UNIQUE("tenant_id","app_id","id","version"),
	CONSTRAINT "workflow_definition_status" CHECK ("workflow_definitions"."status" IN ('draft', 'published'))
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"action_id" uuid,
	"from_state_id" uuid,
	"to_state_id" uuid NOT NULL,
	"reason" text,
	"assignee_ids" jsonb NOT NULL,
	CONSTRAINT "workflow_events_tenant_id_app_id_event_id_pk" PRIMARY KEY("tenant_id","app_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_states" (
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"terminal" boolean NOT NULL,
	"initial" boolean NOT NULL,
	"assignees" jsonb NOT NULL,
	CONSTRAINT "workflow_states_tenant_id_app_id_workflow_id_id_pk" PRIMARY KEY("tenant_id","app_id","workflow_id","id"),
	CONSTRAINT "workflow_states_tenant_id_app_id_workflow_id_code_unique" UNIQUE("tenant_id","app_id","workflow_id","code")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "workflow_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "record_workflow_state" ADD CONSTRAINT "record_workflow_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_workflow_state" ADD CONSTRAINT "record_workflow_state_record_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."records"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_workflow_state" ADD CONSTRAINT "record_workflow_state_version_fk" FOREIGN KEY ("tenant_id","app_id","workflow_id","workflow_version") REFERENCES "public"."workflow_definitions"("tenant_id","app_id","id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_workflow_state" ADD CONSTRAINT "record_workflow_state_state_fk" FOREIGN KEY ("tenant_id","app_id","workflow_id","state_id") REFERENCES "public"."workflow_states"("tenant_id","app_id","workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_from_state_fk" FOREIGN KEY ("tenant_id","app_id","workflow_id","from_state_id") REFERENCES "public"."workflow_states"("tenant_id","app_id","workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_to_state_fk" FOREIGN KEY ("tenant_id","app_id","workflow_id","to_state_id") REFERENCES "public"."workflow_states"("tenant_id","app_id","workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_assignments" ADD CONSTRAINT "workflow_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_assignments" ADD CONSTRAINT "workflow_assignments_record_state_fk" FOREIGN KEY ("tenant_id","app_id","record_id") REFERENCES "public"."record_workflow_state"("tenant_id","app_id","record_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_assignments" ADD CONSTRAINT "workflow_assignments_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_members"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_record_event_fk" FOREIGN KEY ("tenant_id","app_id","event_id") REFERENCES "public"."record_events"("tenant_id","app_id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_action_fk" FOREIGN KEY ("tenant_id","app_id","workflow_id","action_id") REFERENCES "public"."workflow_actions"("tenant_id","app_id","workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_from_state_fk" FOREIGN KEY ("tenant_id","app_id","workflow_id","from_state_id") REFERENCES "public"."workflow_states"("tenant_id","app_id","workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_to_state_fk" FOREIGN KEY ("tenant_id","app_id","workflow_id","to_state_id") REFERENCES "public"."workflow_states"("tenant_id","app_id","workflow_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD CONSTRAINT "workflow_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD CONSTRAINT "workflow_states_definition_fk" FOREIGN KEY ("tenant_id","app_id","workflow_id") REFERENCES "public"."workflow_definitions"("tenant_id","app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_workflow_state_state_idx" ON "record_workflow_state" USING btree ("tenant_id","app_id","state_id");--> statement-breakpoint
CREATE INDEX "workflow_assignments_active_user_idx" ON "workflow_assignments" USING btree ("tenant_id","user_id") WHERE "workflow_assignments"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_one_draft" ON "workflow_definitions" USING btree ("tenant_id","app_id") WHERE "workflow_definitions"."status" = 'draft';
--> statement-breakpoint
GRANT UPDATE (workflow_enabled) ON apps TO suzubase_runtime;
ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_definition_read ON workflow_definitions FOR SELECT TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid);
CREATE POLICY workflow_definition_insert ON workflow_definitions FOR INSERT TO suzubase_runtime
  WITH CHECK (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid AND status = 'draft');
CREATE POLICY workflow_definition_publish ON workflow_definitions FOR UPDATE TO suzubase_runtime
  USING (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid AND status = 'draft')
  WITH CHECK (tenant_id = nullif(current_setting('suzubase.tenant_id', true), '')::uuid AND status = 'published');
GRANT SELECT, INSERT, UPDATE (status) ON workflow_definitions TO suzubase_runtime;

DO $workflow$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['workflow_actions', 'workflow_states']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY workflow_graph_read ON %I FOR SELECT TO suzubase_runtime
       USING (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid)', target);
    EXECUTE format(
      'CREATE POLICY workflow_graph_insert ON %1$I FOR INSERT TO suzubase_runtime
       WITH CHECK (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid AND EXISTS (
         SELECT 1 FROM workflow_definitions d WHERE d.tenant_id = %1$I.tenant_id AND d.app_id = %1$I.app_id
           AND d.id = %1$I.workflow_id AND d.status = ''draft''
       ))', target);
    EXECUTE format(
      'CREATE POLICY workflow_graph_delete ON %1$I FOR DELETE TO suzubase_runtime
       USING (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid AND EXISTS (
         SELECT 1 FROM workflow_definitions d WHERE d.tenant_id = %1$I.tenant_id AND d.app_id = %1$I.app_id
           AND d.id = %1$I.workflow_id AND d.status = ''draft''
       ))', target);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I TO suzubase_runtime', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['record_workflow_state', 'workflow_assignments', 'workflow_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I TO suzubase_runtime
       USING (tenant_id = nullif(current_setting(''suzubase.tenant_id'', true), '''')::uuid)', target);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO suzubase_runtime', target);
  END LOOP;
END
$workflow$;
GRANT UPDATE (state_id, revision) ON record_workflow_state TO suzubase_runtime;
GRANT UPDATE (role, active) ON workflow_assignments TO suzubase_runtime;
