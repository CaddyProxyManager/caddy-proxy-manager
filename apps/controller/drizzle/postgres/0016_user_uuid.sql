-- Opaque user ids for forward auth. Existing rows are filled at startup: uuidv7() needs PG 18.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "uuid" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_uuid_unique" ON "users" ("uuid");--> statement-breakpoint
-- Upstreams of an install that already has users are keyed on the numeric id; keep sending it.
INSERT INTO "settings" ("key", "value", "updatedAt")
SELECT 'config:forward_auth_sequential_user_ids', 'true',
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE EXISTS (SELECT 1 FROM "users")
ON CONFLICT ("key") DO NOTHING;
