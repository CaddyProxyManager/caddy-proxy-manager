-- IP rules can name a host instead of a range; the controller resolves it and caches the answer.
-- SQLite cannot drop NOT NULL in place, so the rules table is rebuilt; nothing references it, which
-- matters because the migrator's transaction makes the foreign_keys pragmas below no-ops.
-- hostname is copied as NULL: the old table has none, and SQLite reads an unknown "hostname" as
-- the string 'hostname'.
CREATE TABLE `access_list_dns_cache` (
	`hostname` text PRIMARY KEY NOT NULL,
	`addresses` text NOT NULL,
	`resolvedAt` text,
	`expiresAt` text NOT NULL,
	`lastError` text,
	`lastErrorAt` text
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_access_list_ip_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`accessListId` integer NOT NULL,
	`action` text NOT NULL,
	`cidr` text,
	`hostname` text,
	`note` text,
	`sortOrder` integer NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`accessListId`) REFERENCES `access_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_access_list_ip_rules`("id", "accessListId", "action", "cidr", "hostname", "note", "sortOrder", "createdAt", "updatedAt") SELECT "id", "accessListId", "action", "cidr", NULL, "note", "sortOrder", "createdAt", "updatedAt" FROM `access_list_ip_rules`;--> statement-breakpoint
DROP TABLE `access_list_ip_rules`;--> statement-breakpoint
ALTER TABLE `__new_access_list_ip_rules` RENAME TO `access_list_ip_rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `access_list_ip_rules_list_idx` ON `access_list_ip_rules` (`accessListId`);