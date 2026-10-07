CREATE TABLE `host_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hostKind` text NOT NULL,
	`hostId` integer NOT NULL,
	`operation` text NOT NULL,
	`detail` text,
	`snapshot` text NOT NULL,
	`userId` integer,
	`userName` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `host_revisions_host_idx` ON `host_revisions` (`hostKind`,`hostId`,`id`);--> statement-breakpoint
CREATE INDEX `host_revisions_created_at_idx` ON `host_revisions` (`createdAt`);