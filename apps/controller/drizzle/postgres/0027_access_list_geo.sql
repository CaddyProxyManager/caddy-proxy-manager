-- Access lists: a deny response and fail closed per list; rules by country, continent and ASN, with an expiry.
ALTER TABLE "access_lists" ADD COLUMN IF NOT EXISTS "denyStatus" integer;
--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN IF NOT EXISTS "denyBody" text;
--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN IF NOT EXISTS "denyRedirectUrl" text;
--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN IF NOT EXISTS "failClosed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "access_list_ip_rules" ADD COLUMN IF NOT EXISTS "country" text;
--> statement-breakpoint
ALTER TABLE "access_list_ip_rules" ADD COLUMN IF NOT EXISTS "continent" text;
--> statement-breakpoint
ALTER TABLE "access_list_ip_rules" ADD COLUMN IF NOT EXISTS "asn" bigint;
--> statement-breakpoint
ALTER TABLE "access_list_ip_rules" ADD COLUMN IF NOT EXISTS "expiresAt" text;
