CREATE TABLE `audit_chain` (
	`id` integer PRIMARY KEY NOT NULL,
	`headSeq` integer NOT NULL,
	`headHash` text NOT NULL,
	`anchorSeq` integer NOT NULL,
	`anchorHash` text NOT NULL,
	`legacyMaxId` integer NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `actorId` integer;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `seq` integer;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `prevHash` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_seq_idx` ON `audit_events` (`seq`);--> statement-breakpoint
INSERT INTO `audit_chain` (`id`, `headSeq`, `headHash`, `anchorSeq`, `anchorHash`, `legacyMaxId`, `updatedAt`) SELECT 1, 0, '0000000000000000000000000000000000000000000000000000000000000000', 0, '0000000000000000000000000000000000000000000000000000000000000000', COALESCE(MAX(`id`), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `audit_events`;