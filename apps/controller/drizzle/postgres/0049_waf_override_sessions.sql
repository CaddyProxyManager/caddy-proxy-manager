-- WAF override mode: a host's WAF set to detect only for one address for a few minutes, and the
-- preset the rules it tripped went into.
CREATE TABLE IF NOT EXISTS "waf_override_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"proxyHostId" integer NOT NULL REFERENCES "public"."proxy_hosts"("id") ON DELETE cascade,
	"clientIp" text NOT NULL,
	"startedBy" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"startedAt" text NOT NULL,
	"expiresAt" text NOT NULL,
	"endedAt" text,
	"presetId" integer REFERENCES "public"."waf_presets"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waf_override_sessions_host_idx" ON "waf_override_sessions" ("proxyHostId");
