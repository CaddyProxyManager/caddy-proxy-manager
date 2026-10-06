-- State replicas must share: who is running, cache generations, guess limits, spent nonces, pairing secrets.
CREATE TABLE IF NOT EXISTS "controller_replicas" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"keyFingerprint" text NOT NULL,
	"startedAt" bigint NOT NULL,
	"heartbeatAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cluster_generations" (
	"name" text PRIMARY KEY NOT NULL,
	"generation" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"resetAt" bigint NOT NULL,
	"blockedUntil" bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_counters_reset_at_idx" ON "rate_limit_counters" ("resetAt");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spent_nonces" (
	"key" text PRIMARY KEY NOT NULL,
	"expiresAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spent_nonces_expires_at_idx" ON "spent_nonces" ("expiresAt");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_pairing_secrets" (
	"slot" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"agentId" text,
	"expiresAt" bigint NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL
);
