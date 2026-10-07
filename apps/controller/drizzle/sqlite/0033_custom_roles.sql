-- Custom roles, a role a group carries, and identity-provider role mappings in their own table.
CREATE TABLE `role_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`providerId` text NOT NULL,
	`role` text NOT NULL,
	`externalName` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`providerId`) REFERENCES `oauth_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `role_mappings_provider_idx` ON `role_mappings` (`providerId`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_mappings_unique` ON `role_mappings` (`providerId`,`role`,`externalName`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`scoped` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_key_unique` ON `roles` (`key`);--> statement-breakpoint
ALTER TABLE `groups` ADD `role` text;--> statement-breakpoint
-- Each comma-separated name in the four role columns becomes a row, in the order it was typed,
-- a repeat once.
WITH RECURSIVE `split`(`providerId`, `rank`, `role`, `n`, `part`, `rest`, `createdAt`) AS (
	SELECT `id`, 1, 'admin', 0, '', `adminGroup` || ',', `updatedAt` FROM `oauth_providers` WHERE `adminGroup` IS NOT NULL
	UNION ALL SELECT `id`, 2, 'operator', 0, '', `operatorGroup` || ',', `updatedAt` FROM `oauth_providers` WHERE `operatorGroup` IS NOT NULL
	UNION ALL SELECT `id`, 3, 'user', 0, '', `userGroup` || ',', `updatedAt` FROM `oauth_providers` WHERE `userGroup` IS NOT NULL
	UNION ALL SELECT `id`, 4, 'viewer', 0, '', `viewerGroup` || ',', `updatedAt` FROM `oauth_providers` WHERE `viewerGroup` IS NOT NULL
	UNION ALL
	SELECT `providerId`, `rank`, `role`, `n` + 1, trim(substr(`rest`, 1, instr(`rest`, ',') - 1)), substr(`rest`, instr(`rest`, ',') + 1), `createdAt`
	FROM `split` WHERE `rest` <> ''
)
INSERT INTO `role_mappings` (`providerId`, `role`, `externalName`, `createdAt`)
SELECT `providerId`, `role`, `part`, `createdAt` FROM `split` WHERE `part` <> ''
GROUP BY `providerId`, `rank`, `role`, `part`, `createdAt` ORDER BY `providerId`, `rank`, min(`n`);--> statement-breakpoint
ALTER TABLE `oauth_providers` DROP COLUMN `adminGroup`;--> statement-breakpoint
ALTER TABLE `oauth_providers` DROP COLUMN `operatorGroup`;--> statement-breakpoint
ALTER TABLE `oauth_providers` DROP COLUMN `userGroup`;--> statement-breakpoint
ALTER TABLE `oauth_providers` DROP COLUMN `viewerGroup`;