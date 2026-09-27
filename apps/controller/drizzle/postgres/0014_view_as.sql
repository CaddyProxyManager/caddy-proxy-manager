-- "View as": an administrator's session narrowed to another role and optional groups.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "viewAsRole" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "viewAsGroupIds" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "viewAsExpiresAt" text;
