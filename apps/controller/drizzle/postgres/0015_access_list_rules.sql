-- Access lists gain ordered IP rules, a default for requests no rule matches, "Satisfy Any", and a
-- choice over forwarding the basic-auth header.
CREATE TABLE IF NOT EXISTS "access_list_ip_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "accessListId" integer NOT NULL REFERENCES "access_lists"("id") ON DELETE cascade,
  "action" text NOT NULL,
  "cidr" text NOT NULL,
  "note" text,
  "sortOrder" integer NOT NULL,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_list_ip_rules_list_idx" ON "access_list_ip_rules" ("accessListId");--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN IF NOT EXISTS "ipDefault" text DEFAULT 'deny' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN IF NOT EXISTS "satisfy" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN IF NOT EXISTS "passAuth" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Lists made before "Pass auth to host" existed kept forwarding the header; they still do.
UPDATE "access_lists" SET "passAuth" = true;
