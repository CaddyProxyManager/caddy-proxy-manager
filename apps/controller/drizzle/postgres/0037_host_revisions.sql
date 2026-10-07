-- A full snapshot after every proxy and L4 host write; no key to the host, so a deleted one keeps its history.
CREATE TABLE IF NOT EXISTS "host_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"hostKind" text NOT NULL,
	"hostId" integer NOT NULL,
	"operation" text NOT NULL,
	"detail" text,
	"snapshot" text NOT NULL,
	"userId" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"userName" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_revisions_host_idx" ON "host_revisions" ("hostKind", "hostId", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_revisions_created_at_idx" ON "host_revisions" ("createdAt");
