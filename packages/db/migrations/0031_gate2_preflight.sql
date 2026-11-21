ALTER TABLE "record_workflow_state" ADD COLUMN "attention_reason" text;
--> statement-breakpoint
GRANT UPDATE (attention_reason) ON record_workflow_state TO suzubase_runtime;
GRANT DELETE ON record_references TO suzubase_runtime;
