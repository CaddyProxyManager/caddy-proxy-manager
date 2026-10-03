-- LDAP directories: oauth_providers rows with type='ldap'.
ALTER TABLE "oauth_providers" ADD COLUMN IF NOT EXISTS "ldapConfig" text;
