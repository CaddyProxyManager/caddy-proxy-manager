CREATE TABLE `change_request_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requestId` integer NOT NULL,
	`userId` integer,
	`userName` text,
	`decision` text NOT NULL,
	`note` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`requestId`) REFERENCES `change_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_request_decisions_once` ON `change_request_decisions` (`requestId`,`userId`);--> statement-breakpoint
CREATE TABLE `change_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`area` text NOT NULL,
	`targetType` text,
	`targetId` integer,
	`targetName` text,
	`payload` text NOT NULL,
	`preview` text NOT NULL,
	`baseState` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`requiredApprovals` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requestedBy` integer,
	`requestedByName` text,
	`viaToken` integer DEFAULT false NOT NULL,
	`bypassedBy` integer,
	`bypassedByName` text,
	`bypassReason` text,
	`resultCode` text,
	`error` text,
	`createdAt` text NOT NULL,
	`decidedAt` text,
	`appliedAt` text,
	FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bypassedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `change_requests_status_idx` ON `change_requests` (`status`,`id`);