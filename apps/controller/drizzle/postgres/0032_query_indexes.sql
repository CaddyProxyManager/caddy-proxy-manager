-- A host's history reads one entity's events newest first; the access-list prune scans expiring rules.
CREATE INDEX IF NOT EXISTS "audit_events_entity_idx" ON "audit_events" ("entityType", "entityId", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_list_ip_rules_expires_at_idx" ON "access_list_ip_rules" ("expiresAt") WHERE "expiresAt" IS NOT NULL;
