CREATE TABLE `blocked_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`expiresAt` text,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocked_sources_kind_value_unique` ON `blocked_sources` (`kind`,`value`);--> statement-breakpoint
CREATE INDEX `blocked_sources_expires_at_idx` ON `blocked_sources` (`expiresAt`);--> statement-breakpoint
CREATE TABLE `waf_event_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`eventKey` text NOT NULL,
	`verdict` text NOT NULL,
	`userId` integer,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waf_event_reviews_event_key_unique` ON `waf_event_reviews` (`eventKey`);--> statement-breakpoint
CREATE TABLE `waf_exclusions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ruleId` integer NOT NULL,
	`proxyHostId` integer,
	`path` text,
	`target` text,
	`reason` text DEFAULT '' NOT NULL,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`proxyHostId`) REFERENCES `proxy_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `waf_exclusions_host_idx` ON `waf_exclusions` (`proxyHostId`);