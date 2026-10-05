-- Labels for finding hosts; the config build never reads them.
ALTER TABLE "proxy_hosts" ADD COLUMN IF NOT EXISTS "tags" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "l4_proxy_hosts" ADD COLUMN IF NOT EXISTS "tags" text DEFAULT '[]' NOT NULL;
