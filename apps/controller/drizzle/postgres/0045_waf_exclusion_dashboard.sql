-- A WAF exclusion for the dashboard host, which has no proxy_hosts row to point at.
ALTER TABLE "waf_exclusions" ADD COLUMN IF NOT EXISTS "dashboard" boolean DEFAULT false NOT NULL;
