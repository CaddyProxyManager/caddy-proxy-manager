ALTER TABLE `audit_chain` ADD `legacyCount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_chain` ADD `seal` text;--> statement-breakpoint
ALTER TABLE `audit_chain` DROP COLUMN `legacyMaxId`;