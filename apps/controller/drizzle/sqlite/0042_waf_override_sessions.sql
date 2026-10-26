-- WAF override mode: a host's WAF set to detect only for one address for a few minutes, and the
-- preset the rules it tripped went into.
CREATE TABLE `waf_override_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proxyHostId` integer NOT NULL,
	`clientIp` text NOT NULL,
	`startedBy` integer,
	`startedAt` text NOT NULL,
	`expiresAt` text NOT NULL,
	`endedAt` text,
	`presetId` integer,
	FOREIGN KEY (`proxyHostId`) REFERENCES `proxy_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`startedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`presetId`) REFERENCES `waf_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `waf_override_sessions_host_idx` ON `waf_override_sessions` (`proxyHostId`);