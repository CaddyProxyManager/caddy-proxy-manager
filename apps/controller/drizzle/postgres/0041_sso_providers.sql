-- SAML providers for the single sign-on plugin; CPM's half of each is its oauth_providers row.
CREATE TABLE IF NOT EXISTS "sso_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidcConfig" text,
	"samlConfig" text,
	"userId" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"providerId" text NOT NULL REFERENCES "public"."oauth_providers"("id") ON DELETE cascade,
	"organizationId" text,
	"domain" text DEFAULT '' NOT NULL,
	"domainVerified" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sso_providers_provider_unique" ON "sso_providers" ("providerId");
