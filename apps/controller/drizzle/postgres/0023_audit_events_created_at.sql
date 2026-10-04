-- The Overview ranges over audit_events by time: its newest-first list and server-events line.
CREATE INDEX IF NOT EXISTS "audit_events_created_at_idx" ON "audit_events" ("createdAt");
