-- Users: the last completed sign-in and display preferences. API tokens: a scope, full by default.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastSignInAt" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastSignInMethod" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "timeZone" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "numberFormat" text;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'full' NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "permissions" text;
