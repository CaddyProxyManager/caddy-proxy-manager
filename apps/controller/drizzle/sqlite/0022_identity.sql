ALTER TABLE `api_tokens` ADD `scope` text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `permissions` text;--> statement-breakpoint
ALTER TABLE `users` ADD `lastSignInAt` text;--> statement-breakpoint
ALTER TABLE `users` ADD `lastSignInMethod` text;--> statement-breakpoint
ALTER TABLE `users` ADD `timeZone` text;--> statement-breakpoint
ALTER TABLE `users` ADD `numberFormat` text;