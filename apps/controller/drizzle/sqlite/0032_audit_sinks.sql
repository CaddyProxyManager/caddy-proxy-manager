CREATE TABLE `audit_security_head` (
	`id` integer PRIMARY KEY NOT NULL,
	`headSeq` integer DEFAULT 0 NOT NULL,
	`prunedSeq` integer DEFAULT 0 NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_security_records` (
	`seq` integer PRIMARY KEY NOT NULL,
	`record` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_security_records_created_at_idx` ON `audit_security_records` (`createdAt`);--> statement-breakpoint
CREATE TABLE `audit_sinks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secret` text DEFAULT '' NOT NULL,
	`includeSecurity` integer DEFAULT false NOT NULL,
	`auditCursor` integer DEFAULT 0 NOT NULL,
	`securityCursor` integer DEFAULT 0 NOT NULL,
	`encodingFallback` integer DEFAULT false NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`retryAt` text,
	`lastDeliveredAt` text,
	`lastError` text,
	`lastErrorAt` text,
	`lastErrorCode` text,
	`gapStream` text,
	`gapFrom` integer,
	`gapTo` integer,
	`gapAt` text,
	`missed` integer DEFAULT 0 NOT NULL,
	`leaseOwner` text,
	`leaseUntil` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_sinks_name_unique` ON `audit_sinks` (`name`);