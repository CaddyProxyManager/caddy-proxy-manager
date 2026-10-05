-- Named analytics page states, per user, optionally shared with everyone who can open analytics.
CREATE TABLE IF NOT EXISTS "analytics_views" (
  "id" serial PRIMARY KEY NOT NULL,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "query" text NOT NULL,
  "shared" boolean DEFAULT false NOT NULL,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_views_user_idx" ON "analytics_views" ("userId");
