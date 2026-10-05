ALTER TABLE `access_list_ip_rules` ADD `country` text;--> statement-breakpoint
ALTER TABLE `access_list_ip_rules` ADD `continent` text;--> statement-breakpoint
ALTER TABLE `access_list_ip_rules` ADD `asn` integer;--> statement-breakpoint
ALTER TABLE `access_list_ip_rules` ADD `expiresAt` text;--> statement-breakpoint
ALTER TABLE `access_lists` ADD `denyStatus` integer;--> statement-breakpoint
ALTER TABLE `access_lists` ADD `denyBody` text;--> statement-breakpoint
ALTER TABLE `access_lists` ADD `denyRedirectUrl` text;--> statement-breakpoint
ALTER TABLE `access_lists` ADD `failClosed` integer DEFAULT false NOT NULL;