-- Free-text notes on a host, as access lists and groups already have.
ALTER TABLE "proxy_hosts" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "l4_proxy_hosts" ADD COLUMN IF NOT EXISTS "description" text;
