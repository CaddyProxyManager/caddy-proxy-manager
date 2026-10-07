-- SCIM provisioning: CPM's connections and role mappings, then the SCIM plugin's own tables.
CREATE TABLE IF NOT EXISTS "scim_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"tokenHash" text NOT NULL,
	"tokenHint" text NOT NULL,
	"linkExisting" boolean DEFAULT true NOT NULL,
	"createdBy" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"lastUsedAt" text,
	"tokenRotatedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_connections_name_unique" ON "scim_connections" ("name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_connections_token_hash_unique" ON "scim_connections" ("tokenHash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_role_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"connectionId" integer NOT NULL REFERENCES "public"."scim_connections"("id") ON DELETE cascade,
	"role" text NOT NULL,
	"externalName" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_role_mappings_connection_idx" ON "scim_role_mappings" ("connectionId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_role_mappings_unique" ON "scim_role_mappings" ("connectionId","role","externalName");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_connection_bindings" (
	"id" serial PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"connectionKey" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"createdAt" text NOT NULL,
	"decommissionedAt" text,
	"decommissionStatus" text DEFAULT 'active' NOT NULL,
	"decommissionCursorUserId" text,
	"decommissionReconciledUserCount" bigint DEFAULT 0 NOT NULL,
	"decommissionBatchCount" bigint DEFAULT 0 NOT NULL,
	"decommissionRevision" bigint DEFAULT 0 NOT NULL,
	"decommissionCompletedAt" text,
	"decommissionLeaseId" text,
	"decommissionLeaseExpiresAt" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_connection_bindings_connectionId_idx" ON "scim_connection_bindings" ("connectionId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_connection_bindings_connectionKey_unique" ON "scim_connection_bindings" ("connectionKey");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_identity_tombstones" (
	"id" serial PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"externalId" text NOT NULL,
	"externalIdKey" text NOT NULL,
	"userId" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"profile" text NOT NULL,
	"deletedAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_identity_tombstones_connectionId_idx" ON "scim_identity_tombstones" ("connectionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_identity_tombstones_provisioningDomainId_idx" ON "scim_identity_tombstones" ("provisioningDomainId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_identity_tombstones_externalIdKey_unique" ON "scim_identity_tombstones" ("externalIdKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_identity_tombstones_userId_idx" ON "scim_identity_tombstones" ("userId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"profileSourceId" text,
	"revision" bigint NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_subjects_userId_unique" ON "scim_subjects" ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_subjects_profileSourceId_idx" ON "scim_subjects" ("profileSourceId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"userId" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"connectionUserKey" text NOT NULL,
	"userName" text NOT NULL,
	"userNameKey" text NOT NULL,
	"primaryEmail" text NOT NULL,
	"workEmailValueIndex" text NOT NULL,
	"emailValueIndex" text NOT NULL,
	"displayName" text NOT NULL,
	"formattedName" text NOT NULL,
	"givenName" text,
	"familyName" text,
	"serializedEmails" text NOT NULL,
	"serializedAttributes" text,
	"externalId" text,
	"externalIdKey" text,
	"active" boolean NOT NULL,
	"orderKey" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_users_connectionId_idx" ON "scim_users" ("connectionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_users_provisioningDomainId_idx" ON "scim_users" ("provisioningDomainId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_users_userId_idx" ON "scim_users" ("userId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_users_connectionUserKey_unique" ON "scim_users" ("connectionUserKey");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_users_userNameKey_unique" ON "scim_users" ("userNameKey");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_users_externalIdKey_unique" ON "scim_users" ("externalIdKey");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_users_orderKey_unique" ON "scim_users" ("orderKey");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_projection_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"scimUserId" integer NOT NULL REFERENCES "public"."scim_users"("id") ON DELETE cascade,
	"userId" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"sourceKind" text NOT NULL,
	"sourceId" text NOT NULL,
	"sourceValue" text,
	"role" text NOT NULL,
	"grantKey" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_projection_grants_connectionId_idx" ON "scim_projection_grants" ("connectionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_projection_grants_provisioningDomainId_idx" ON "scim_projection_grants" ("provisioningDomainId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_projection_grants_scimUserId_idx" ON "scim_projection_grants" ("scimUserId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_projection_grants_userId_idx" ON "scim_projection_grants" ("userId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_projection_grants_grantKey_unique" ON "scim_projection_grants" ("grantKey");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"displayName" text NOT NULL,
	"displayNameKey" text NOT NULL,
	"externalId" text,
	"externalIdKey" text,
	"orderKey" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_groups_connectionId_idx" ON "scim_groups" ("connectionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_groups_provisioningDomainId_idx" ON "scim_groups" ("provisioningDomainId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_displayNameKey_unique" ON "scim_groups" ("displayNameKey");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_externalIdKey_unique" ON "scim_groups" ("externalIdKey");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_orderKey_unique" ON "scim_groups" ("orderKey");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_group_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"groupId" integer NOT NULL REFERENCES "public"."scim_groups"("id") ON DELETE cascade,
	"scimUserId" integer NOT NULL REFERENCES "public"."scim_users"("id") ON DELETE cascade,
	"membershipKey" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_group_members_connectionId_idx" ON "scim_group_members" ("connectionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_group_members_groupId_idx" ON "scim_group_members" ("groupId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_group_members_scimUserId_idx" ON "scim_group_members" ("scimUserId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_group_members_membershipKey_unique" ON "scim_group_members" ("membershipKey");
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "scimGroupId" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "groups_scim_group_unique" ON "groups" ("scimGroupId");
