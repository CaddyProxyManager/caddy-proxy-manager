CREATE TABLE `agent_command_results` (
	`commandId` text PRIMARY KEY NOT NULL,
	`replicaId` text NOT NULL,
	`result` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_command_results_replica_idx` ON `agent_command_results` (`replicaId`);--> statement-breakpoint
CREATE TABLE `agent_connections` (
	`agentId` text PRIMARY KEY NOT NULL,
	`replicaId` text NOT NULL,
	`agentRowId` integer NOT NULL,
	`name` text NOT NULL,
	`credential` text,
	`connectedAt` integer NOT NULL,
	`lastSeenAt` integer NOT NULL,
	`status` text
);
--> statement-breakpoint
CREATE INDEX `agent_connections_replica_idx` ON `agent_connections` (`replicaId`);--> statement-breakpoint
CREATE TABLE `agent_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`replicaId` text NOT NULL,
	`agentId` text NOT NULL,
	`event` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_outbox_replica_idx` ON `agent_outbox` (`replicaId`);--> statement-breakpoint
CREATE TABLE `upstream_error_counts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proxyHostId` integer NOT NULL,
	`minute` integer NOT NULL,
	`count` integer NOT NULL,
	FOREIGN KEY (`proxyHostId`) REFERENCES `proxy_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upstream_error_counts_host_minute_unique` ON `upstream_error_counts` (`proxyHostId`,`minute`);--> statement-breakpoint
CREATE INDEX `upstream_error_counts_minute_idx` ON `upstream_error_counts` (`minute`);