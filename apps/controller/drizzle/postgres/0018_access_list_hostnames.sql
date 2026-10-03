-- IP rules can name a host instead of a range; the controller resolves it and caches the answer.
ALTER TABLE "access_list_ip_rules" ALTER COLUMN "cidr" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_list_ip_rules" ADD COLUMN IF NOT EXISTS "hostname" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "access_list_dns_cache" (
  "hostname" text PRIMARY KEY NOT NULL,
  "addresses" text NOT NULL,
  "resolvedAt" text,
  "expiresAt" text NOT NULL,
  "lastError" text,
  "lastErrorAt" text
);
