CREATE TABLE `alert_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`eventId` integer NOT NULL,
	`channelId` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`reached` text DEFAULT '[]' NOT NULL,
	`claimedBy` text,
	`claimedUntil` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`sentAt` text,
	FOREIGN KEY (`eventId`) REFERENCES `alert_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channelId`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_deliveries_event_channel_unique` ON `alert_deliveries` (`eventId`,`channelId`);--> statement-breakpoint
CREATE INDEX `alert_deliveries_channel_status_idx` ON `alert_deliveries` (`channelId`,`status`);--> statement-breakpoint
CREATE TABLE `alert_digest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`digestId` integer NOT NULL,
	`slot` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`results` text DEFAULT '[]' NOT NULL,
	`error` text,
	`replica` text,
	`startedAt` text NOT NULL,
	`finishedAt` text,
	FOREIGN KEY (`digestId`) REFERENCES `alert_digests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_digest_runs_digest_slot_unique` ON `alert_digest_runs` (`digestId`,`slot`);--> statement-breakpoint
CREATE TABLE `alert_digests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`time` text NOT NULL,
	`timeZone` text DEFAULT 'UTC' NOT NULL,
	`channelIds` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`scheduledSince` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_digests_name_unique` ON `alert_digests` (`name`);--> statement-breakpoint
CREATE TABLE `alert_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`ruleId` integer,
	`kind` text NOT NULL,
	`category` text,
	`severity` text NOT NULL,
	`type` text NOT NULL,
	`event` text NOT NULL,
	`at` text NOT NULL,
	`resolvedAt` text,
	FOREIGN KEY (`ruleId`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alert_events_at_idx` ON `alert_events` (`at`);--> statement-breakpoint
CREATE INDEX `alert_events_rule_key_idx` ON `alert_events` (`ruleId`,`key`);--> statement-breakpoint
CREATE TABLE `alert_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`openAt` text,
	`openEvent` text,
	`openEventIds` text DEFAULT '[]' NOT NULL,
	`openRuleIds` text DEFAULT '[]' NOT NULL,
	`quietUntil` text,
	`streak` integer DEFAULT 0 NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`builtin` text,
	`source` text NOT NULL,
	`sourceConfig` text DEFAULT '{}' NOT NULL,
	`scope` text DEFAULT 'all' NOT NULL,
	`scopeValues` text DEFAULT '[]' NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`channelIds` text DEFAULT '[]' NOT NULL,
	`quietMinutes` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`silencedUntil` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_rules_builtin_unique` ON `alert_rules` (`builtin`);--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`builtin` text,
	`config` text DEFAULT '{}' NOT NULL,
	`secret` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`retryAt` text,
	`lastSentAt` text,
	`lastError` text,
	`lastErrorAt` text,
	`lastErrorCode` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_channels_name_unique` ON `notification_channels` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_channels_builtin_unique` ON `notification_channels` (`builtin`);