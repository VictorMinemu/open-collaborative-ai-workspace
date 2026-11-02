-- Phase 07.6 review HI-01: a write lease on a watched record. The compare-and-set of `ocw_record_update` takes it
-- atomically (only while no other lease is live and the snapshot is still the one compared) and clears it when the write
-- ends, so two writes on one record never run at the same time. Nullable, no default: existing rows hold no lease.
-- Rollback (as ocw_migrator): alter table app.watched_records drop column write_lease_until;
ALTER TABLE "app"."watched_records" ADD COLUMN "write_lease_until" timestamp with time zone;
