-- P3-C C-0 (option a): system actions have no tenant-member actor.
-- automation_audit_events.actor_id becomes nullable and a dedicated
-- actor_type column marks the origin: 'USER' rows must carry a real
-- tenant-member actor (FK still applies), 'SYSTEM' rows must carry
-- actor_id NULL so a system action never masquerades as a member.
-- Existing rows are all member actions and default to 'USER'.
ALTER TABLE automation_audit_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE automation_audit_events
  ADD COLUMN actor_type text NOT NULL DEFAULT 'USER';
ALTER TABLE automation_audit_events
  ADD CONSTRAINT automation_audit_events_actor_type_check
  CHECK (actor_type IN ('USER', 'SYSTEM'));
ALTER TABLE automation_audit_events
  ADD CONSTRAINT automation_audit_events_actor_consistency_check
  CHECK (
    (actor_type = 'USER' AND actor_id IS NOT NULL)
    OR (actor_type = 'SYSTEM' AND actor_id IS NULL)
  );
