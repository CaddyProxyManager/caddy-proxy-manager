-- Agent streams across replicas: who holds each, events and results in flight, and upstream errors.
CREATE TABLE IF NOT EXISTS "agent_connections" (
	"agentId" text PRIMARY KEY NOT NULL,
	"replicaId" text NOT NULL,
	"agentRowId" integer NOT NULL,
	"name" text NOT NULL,
	"credential" text,
	"connectedAt" bigint NOT NULL,
	"lastSeenAt" bigint NOT NULL,
	"status" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_connections_replica_idx" ON "agent_connections" ("replicaId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"replicaId" text NOT NULL,
	"agentId" text NOT NULL,
	"event" text NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_outbox_replica_idx" ON "agent_outbox" ("replicaId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_command_results" (
	"commandId" text PRIMARY KEY NOT NULL,
	"replicaId" text NOT NULL,
	"result" text NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_command_results_replica_idx" ON "agent_command_results" ("replicaId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "upstream_error_counts" (
	"id" serial PRIMARY KEY NOT NULL,
	"proxyHostId" integer NOT NULL REFERENCES "public"."proxy_hosts"("id") ON DELETE cascade,
	"minute" bigint NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "upstream_error_counts_host_minute_unique" ON "upstream_error_counts" ("proxyHostId", "minute");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_error_counts_minute_idx" ON "upstream_error_counts" ("minute");
