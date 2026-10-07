-- Custom roles, a role a group carries, and identity-provider role mappings in their own table.
CREATE TABLE IF NOT EXISTS "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"capabilities" text DEFAULT '[]' NOT NULL,
	"scoped" boolean DEFAULT false NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_key_unique" ON "roles" ("key");
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "role" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"providerId" text NOT NULL REFERENCES "public"."oauth_providers"("id") ON DELETE cascade,
	"role" text NOT NULL,
	"externalName" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_mappings_provider_idx" ON "role_mappings" ("providerId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_mappings_unique" ON "role_mappings" ("providerId","role","externalName");
--> statement-breakpoint
-- Each comma-separated name in the four role columns becomes a row, in the order it was typed,
-- a repeat once.
INSERT INTO "role_mappings" ("providerId", "role", "externalName", "createdAt")
SELECT p."id", m."role", btrim(u."part"), p."updatedAt"
FROM "oauth_providers" p
CROSS JOIN LATERAL (
	VALUES (1, 'admin', p."adminGroup"), (2, 'operator', p."operatorGroup"),
		(3, 'user', p."userGroup"), (4, 'viewer', p."viewerGroup")
) AS m("rank", "role", "names")
CROSS JOIN LATERAL unnest(string_to_array(m."names", ',')) WITH ORDINALITY AS u("part", "n")
WHERE m."names" IS NOT NULL AND btrim(u."part") <> ''
GROUP BY p."id", m."rank", m."role", btrim(u."part"), p."updatedAt"
ORDER BY p."id", m."rank", min(u."n");
--> statement-breakpoint
ALTER TABLE "oauth_providers" DROP COLUMN IF EXISTS "adminGroup";
--> statement-breakpoint
ALTER TABLE "oauth_providers" DROP COLUMN IF EXISTS "operatorGroup";
--> statement-breakpoint
ALTER TABLE "oauth_providers" DROP COLUMN IF EXISTS "userGroup";
--> statement-breakpoint
ALTER TABLE "oauth_providers" DROP COLUMN IF EXISTS "viewerGroup";
