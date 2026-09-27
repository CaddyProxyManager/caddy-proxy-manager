-- Better Auth's two-factor plugin: a flag on the user and one TOTP secret per user.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "two_factors" (
  "id" serial PRIMARY KEY NOT NULL,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "verified" boolean DEFAULT true NOT NULL,
  "failedVerificationCount" integer DEFAULT 0 NOT NULL,
  "lockedUntil" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "two_factors_user_unique" ON "two_factors" ("userId");
