-- Scoped WAF exclusions, reviewed WAF events and the global blocked-sources list.
CREATE TABLE IF NOT EXISTS "waf_exclusions" (
  "id" serial PRIMARY KEY NOT NULL,
  "ruleId" integer NOT NULL,
  "proxyHostId" integer REFERENCES "proxy_hosts"("id") ON DELETE cascade,
  "path" text,
  "target" text,
  "reason" text DEFAULT '' NOT NULL,
  "createdBy" integer REFERENCES "users"("id") ON DELETE set null,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waf_exclusions_host_idx" ON "waf_exclusions" ("proxyHostId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "waf_event_reviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "eventKey" text NOT NULL,
  "verdict" text NOT NULL,
  "userId" integer REFERENCES "users"("id") ON DELETE set null,
  "createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "waf_event_reviews_event_key_unique" ON "waf_event_reviews" ("eventKey");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blocked_sources" (
  "id" serial PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "expiresAt" text,
  "createdBy" integer REFERENCES "users"("id") ON DELETE set null,
  "createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blocked_sources_kind_value_unique" ON "blocked_sources" ("kind","value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocked_sources_expires_at_idx" ON "blocked_sources" ("expiresAt");
