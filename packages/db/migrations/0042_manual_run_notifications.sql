-- P3-B: manual automation runs have no originating record event. RECORD
-- notifications keep their app/record linkage; the event link becomes
-- optional for this case (event-triggered notifications still always
-- carry one, and the composite FK still applies whenever it is present).
ALTER TABLE notifications DROP CONSTRAINT notifications_record_source_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_record_source_check
  CHECK (
    (source_type = 'RECORD' AND app_id IS NOT NULL AND record_id IS NOT NULL)
    OR (source_type = 'SYSTEM' AND app_id IS NULL AND record_id IS NULL AND event_id IS NULL)
  );
