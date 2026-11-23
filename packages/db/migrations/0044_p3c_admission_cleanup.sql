-- P3-C C-2: run-status value disposition (see P3-REPORT, P3-C section C-2).
-- RATE_LIMITED / BACKLOG_LIMITED were never written as run statuses: they
-- are guardrail signals recorded as automation_audit_events actions (the
-- outbox event stays unprocessed and no run is created). They are removed
-- from the run CHECK and from the UI status filter; the audit actions of
-- the same names stay.
-- ACTIONS_NOT_IMPLEMENTED was the P3-A deferred terminal state. No code
-- since P3-B writes it (real action outcomes replaced it), and a fresh
-- database contains no such rows. Any legacy P3-A row is converted to
-- FAILED with an explicit last_error annotation instead of being silently
-- dropped or promoted: its action rows keep their NOT_EXECUTED /
-- P3B_DEFERRED evidence untouched, and the run can only ever be recovered
-- by an operator-initiated retry, never by automatic replay.
UPDATE automation_runs
SET status = 'FAILED',
    last_error = COALESCE(last_error,
      'Legacy P3-A deferred run (ACTIONS_NOT_IMPLEMENTED): actions were never executed.')
WHERE status = 'ACTIONS_NOT_IMPLEMENTED';

ALTER TABLE automation_runs DROP CONSTRAINT automation_run_status;
ALTER TABLE automation_runs ADD CONSTRAINT automation_run_status CHECK (status IN (
  'QUEUED','RUNNING','SUCCEEDED','FAILED','SKIPPED_CONDITION','SKIPPED_STALE',
  'SKIPPED_UNAUTHORIZED','BLOCKED_CYCLE','CHAIN_DEPTH_EXCEEDED','CHAIN_PAUSED'
));
