-- A claim of its own for OIDC role mapping; null keeps reading roles from the groups claim.
ALTER TABLE "oauth_providers" ADD COLUMN IF NOT EXISTS "rolesClaim" text;
