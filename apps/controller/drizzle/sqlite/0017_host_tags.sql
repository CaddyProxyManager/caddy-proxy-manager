ALTER TABLE `l4_proxy_hosts` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `tags` text DEFAULT '[]' NOT NULL;