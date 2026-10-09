-- Opaque host ids for URLs and the REST API; the serial id stays the key. Random v4 here, as SQL cannot make a v7.
ALTER TABLE `l4_proxy_hosts` ADD `uuid` text;--> statement-breakpoint
UPDATE `l4_proxy_hosts` SET `uuid` = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))));--> statement-breakpoint
CREATE UNIQUE INDEX `l4_proxy_hosts_uuid_unique` ON `l4_proxy_hosts` (`uuid`);--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `uuid` text;--> statement-breakpoint
UPDATE `proxy_hosts` SET `uuid` = (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))));--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_hosts_uuid_unique` ON `proxy_hosts` (`uuid`);
