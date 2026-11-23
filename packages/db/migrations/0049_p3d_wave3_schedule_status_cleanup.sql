-- P3-D wave3 (brief appendix-4 item 2): automation_schedules.status CHECK
-- (added by 0040) still lists two values no code path ever writes on this
-- table: SCHEDULED and SKIPPED_NONEXISTENT_TIME. The latter is a LIVE value
-- on automation_cadence_slots (0045) and is deliberately NOT touched there.
-- Live values on automation_schedules, from the date-relative worker and
-- plan sync: PENDING, SUCCEEDED, FAILED, INVALIDATED, MISSED, LATE,
-- CANCELLED. Tighten the CHECK to exactly that set.
ALTER TABLE automation_schedules DROP CONSTRAINT automation_schedules_status_check;
ALTER TABLE automation_schedules ADD CONSTRAINT automation_schedules_status_check
  CHECK (status IN (
    'PENDING','SUCCEEDED','FAILED','INVALIDATED','MISSED','LATE','CANCELLED'
  ));
