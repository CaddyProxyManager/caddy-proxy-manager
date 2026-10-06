CREATE TABLE `agent_pairing_secrets` (
	`slot` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`agentId` text,
	`expiresAt` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cluster_generations` (
	`name` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `controller_replicas` (
	`id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`keyFingerprint` text NOT NULL,
	`startedAt` integer NOT NULL,
	`heartbeatAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limit_counters` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`resetAt` integer NOT NULL,
	`blockedUntil` integer
);
--> statement-breakpoint
CREATE INDEX `rate_limit_counters_reset_at_idx` ON `rate_limit_counters` (`resetAt`);--> statement-breakpoint
CREATE TABLE `spent_nonces` (
	`key` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `spent_nonces_expires_at_idx` ON `spent_nonces` (`expiresAt`);