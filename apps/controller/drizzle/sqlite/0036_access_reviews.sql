CREATE TABLE `access_review_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`scopeRef` text,
	`dueOn` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`createdBy` integer,
	`closedBy` integer,
	`closedAt` text,
	`appliedBy` integer,
	`appliedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`closedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`appliedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `access_review_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaignId` integer NOT NULL,
	`kind` text NOT NULL,
	`userId` integer,
	`groupId` integer,
	`tokenId` integer,
	`connectionId` integer,
	`objectKind` text,
	`objectId` integer,
	`subjectLabel` text NOT NULL,
	`targetLabel` text,
	`current` text,
	`hints` text DEFAULT '[]' NOT NULL,
	`scimManaged` integer DEFAULT false NOT NULL,
	`reviewerId` integer,
	`decision` text,
	`changeTo` text,
	`note` text,
	`decidedBy` integer,
	`decidedAt` text,
	`outcome` text,
	`outcomeCode` text,
	`appliedAt` text,
	FOREIGN KEY (`campaignId`) REFERENCES `access_review_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`groupId`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tokenId`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`connectionId`) REFERENCES `scim_connections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewerId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decidedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `access_review_items_campaign_idx` ON `access_review_items` (`campaignId`);--> statement-breakpoint
CREATE INDEX `access_review_items_reviewer_idx` ON `access_review_items` (`reviewerId`);