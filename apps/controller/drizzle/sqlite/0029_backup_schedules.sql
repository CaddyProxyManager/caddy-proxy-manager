CREATE TABLE `backup_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`endpoint` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`bucket` text DEFAULT '' NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`accessKeyId` text DEFAULT '' NOT NULL,
	`secretAccessKey` text DEFAULT '' NOT NULL,
	`virtualHostedStyle` integer DEFAULT false NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_destinations_name_unique` ON `backup_destinations` (`name`);--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scheduleId` integer NOT NULL,
	`slot` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`objectKey` text,
	`bytes` integer,
	`durationMs` integer,
	`error` text,
	`errorCode` text,
	`replica` text,
	`startedAt` text NOT NULL,
	`finishedAt` text,
	FOREIGN KEY (`scheduleId`) REFERENCES `backup_schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_runs_schedule_slot_unique` ON `backup_runs` (`scheduleId`,`slot`);--> statement-breakpoint
CREATE INDEX `backup_runs_started_at_idx` ON `backup_runs` (`startedAt`);--> statement-breakpoint
CREATE TABLE `backup_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`destinationId` integer NOT NULL,
	`cron` text NOT NULL,
	`timeZone` text DEFAULT 'UTC' NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`includeAuditLog` integer DEFAULT false NOT NULL,
	`includeSettingsHistory` integer DEFAULT false NOT NULL,
	`keepLast` integer,
	`keepDays` integer,
	`passphrase` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`scheduledSince` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`destinationId`) REFERENCES `backup_destinations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_schedules_name_unique` ON `backup_schedules` (`name`);