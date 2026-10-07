-- SCIM provisioning: CPM's connections and role mappings, then the SCIM plugin's own tables.
CREATE TABLE `scim_connection_bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connectionId` text NOT NULL,
	`connectionKey` text NOT NULL,
	`provisioningDomainId` text NOT NULL,
	`createdAt` text NOT NULL,
	`decommissionedAt` text,
	`decommissionStatus` text DEFAULT 'active' NOT NULL,
	`decommissionCursorUserId` text,
	`decommissionReconciledUserCount` integer DEFAULT 0 NOT NULL,
	`decommissionBatchCount` integer DEFAULT 0 NOT NULL,
	`decommissionRevision` integer DEFAULT 0 NOT NULL,
	`decommissionCompletedAt` text,
	`decommissionLeaseId` text,
	`decommissionLeaseExpiresAt` text
);
--> statement-breakpoint
CREATE INDEX `scim_connection_bindings_connectionId_idx` ON `scim_connection_bindings` (`connectionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_connection_bindings_connectionKey_unique` ON `scim_connection_bindings` (`connectionKey`);--> statement-breakpoint
CREATE TABLE `scim_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`tokenHash` text NOT NULL,
	`tokenHint` text NOT NULL,
	`linkExisting` integer DEFAULT true NOT NULL,
	`createdBy` integer,
	`lastUsedAt` text,
	`tokenRotatedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_connections_name_unique` ON `scim_connections` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_connections_token_hash_unique` ON `scim_connections` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `scim_group_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connectionId` text NOT NULL,
	`groupId` integer NOT NULL,
	`scimUserId` integer NOT NULL,
	`membershipKey` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`groupId`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scimUserId`) REFERENCES `scim_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scim_group_members_connectionId_idx` ON `scim_group_members` (`connectionId`);--> statement-breakpoint
CREATE INDEX `scim_group_members_groupId_idx` ON `scim_group_members` (`groupId`);--> statement-breakpoint
CREATE INDEX `scim_group_members_scimUserId_idx` ON `scim_group_members` (`scimUserId`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_members_membershipKey_unique` ON `scim_group_members` (`membershipKey`);--> statement-breakpoint
CREATE TABLE `scim_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connectionId` text NOT NULL,
	`provisioningDomainId` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`displayName` text NOT NULL,
	`displayNameKey` text NOT NULL,
	`externalId` text,
	`externalIdKey` text,
	`orderKey` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scim_groups_connectionId_idx` ON `scim_groups` (`connectionId`);--> statement-breakpoint
CREATE INDEX `scim_groups_provisioningDomainId_idx` ON `scim_groups` (`provisioningDomainId`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_displayNameKey_unique` ON `scim_groups` (`displayNameKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_externalIdKey_unique` ON `scim_groups` (`externalIdKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_orderKey_unique` ON `scim_groups` (`orderKey`);--> statement-breakpoint
CREATE TABLE `scim_identity_tombstones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connectionId` text NOT NULL,
	`provisioningDomainId` text NOT NULL,
	`externalId` text NOT NULL,
	`externalIdKey` text NOT NULL,
	`userId` integer NOT NULL,
	`profile` text NOT NULL,
	`deletedAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scim_identity_tombstones_connectionId_idx` ON `scim_identity_tombstones` (`connectionId`);--> statement-breakpoint
CREATE INDEX `scim_identity_tombstones_provisioningDomainId_idx` ON `scim_identity_tombstones` (`provisioningDomainId`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_identity_tombstones_externalIdKey_unique` ON `scim_identity_tombstones` (`externalIdKey`);--> statement-breakpoint
CREATE INDEX `scim_identity_tombstones_userId_idx` ON `scim_identity_tombstones` (`userId`);--> statement-breakpoint
CREATE TABLE `scim_projection_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connectionId` text NOT NULL,
	`provisioningDomainId` text NOT NULL,
	`scimUserId` integer NOT NULL,
	`userId` integer NOT NULL,
	`sourceKind` text NOT NULL,
	`sourceId` text NOT NULL,
	`sourceValue` text,
	`role` text NOT NULL,
	`grantKey` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`scimUserId`) REFERENCES `scim_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scim_projection_grants_connectionId_idx` ON `scim_projection_grants` (`connectionId`);--> statement-breakpoint
CREATE INDEX `scim_projection_grants_provisioningDomainId_idx` ON `scim_projection_grants` (`provisioningDomainId`);--> statement-breakpoint
CREATE INDEX `scim_projection_grants_scimUserId_idx` ON `scim_projection_grants` (`scimUserId`);--> statement-breakpoint
CREATE INDEX `scim_projection_grants_userId_idx` ON `scim_projection_grants` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_projection_grants_grantKey_unique` ON `scim_projection_grants` (`grantKey`);--> statement-breakpoint
CREATE TABLE `scim_role_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connectionId` integer NOT NULL,
	`role` text NOT NULL,
	`externalName` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`connectionId`) REFERENCES `scim_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scim_role_mappings_connection_idx` ON `scim_role_mappings` (`connectionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_role_mappings_unique` ON `scim_role_mappings` (`connectionId`,`role`,`externalName`);--> statement-breakpoint
CREATE TABLE `scim_subjects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`profileSourceId` text,
	`revision` integer NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_subjects_userId_unique` ON `scim_subjects` (`userId`);--> statement-breakpoint
CREATE INDEX `scim_subjects_profileSourceId_idx` ON `scim_subjects` (`profileSourceId`);--> statement-breakpoint
CREATE TABLE `scim_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connectionId` text NOT NULL,
	`provisioningDomainId` text NOT NULL,
	`userId` integer NOT NULL,
	`connectionUserKey` text NOT NULL,
	`userName` text NOT NULL,
	`userNameKey` text NOT NULL,
	`primaryEmail` text NOT NULL,
	`workEmailValueIndex` text NOT NULL,
	`emailValueIndex` text NOT NULL,
	`displayName` text NOT NULL,
	`formattedName` text NOT NULL,
	`givenName` text,
	`familyName` text,
	`serializedEmails` text NOT NULL,
	`serializedAttributes` text,
	`externalId` text,
	`externalIdKey` text,
	`active` integer NOT NULL,
	`orderKey` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scim_users_connectionId_idx` ON `scim_users` (`connectionId`);--> statement-breakpoint
CREATE INDEX `scim_users_provisioningDomainId_idx` ON `scim_users` (`provisioningDomainId`);--> statement-breakpoint
CREATE INDEX `scim_users_userId_idx` ON `scim_users` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_connectionUserKey_unique` ON `scim_users` (`connectionUserKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_userNameKey_unique` ON `scim_users` (`userNameKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_externalIdKey_unique` ON `scim_users` (`externalIdKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_orderKey_unique` ON `scim_users` (`orderKey`);--> statement-breakpoint
ALTER TABLE `groups` ADD `scimGroupId` text;--> statement-breakpoint
CREATE UNIQUE INDEX `groups_scim_group_unique` ON `groups` (`scimGroupId`);