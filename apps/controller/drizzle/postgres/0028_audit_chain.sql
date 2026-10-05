-- Audit events form a hash chain; audit_chain holds its head, which every chained insert locks.
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "actorId" integer;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "seq" integer;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "prevHash" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_events_seq_idx" ON "audit_events" ("seq");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_chain" (
  "id" integer PRIMARY KEY NOT NULL,
  "headSeq" integer NOT NULL,
  "headHash" text NOT NULL,
  "anchorSeq" integer NOT NULL,
  "anchorHash" text NOT NULL,
  "legacyMaxId" integer NOT NULL,
  "updatedAt" text NOT NULL
);
--> statement-breakpoint
-- Genesis: everything already logged predates the chain.
INSERT INTO "audit_chain" ("id", "headSeq", "headHash", "anchorSeq", "anchorHash", "legacyMaxId", "updatedAt")
SELECT 1, 0, repeat('0', 64), 0, repeat('0', 64), COALESCE(MAX("id"), 0), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "audit_events"
ON CONFLICT ("id") DO NOTHING;
