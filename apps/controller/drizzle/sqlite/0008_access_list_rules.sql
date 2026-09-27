CREATE TABLE `access_list_ip_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`accessListId` integer NOT NULL,
	`action` text NOT NULL,
	`cidr` text NOT NULL,
	`note` text,
	`sortOrder` integer NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`accessListId`) REFERENCES `access_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `access_list_ip_rules_list_idx` ON `access_list_ip_rules` (`accessListId`);--> statement-breakpoint
ALTER TABLE `access_lists` ADD `ipDefault` text DEFAULT 'deny' NOT NULL;--> statement-breakpoint
ALTER TABLE `access_lists` ADD `satisfy` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `access_lists` ADD `passAuth` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Lists made before "Pass auth to host" existed kept forwarding the header; they still do.
UPDATE `access_lists` SET `passAuth` = 1;