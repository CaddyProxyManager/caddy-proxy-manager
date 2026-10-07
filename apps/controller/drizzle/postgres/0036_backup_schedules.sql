-- Scheduled backups: where they go, when they run, and one row per run claimed before it starts.
CREATE TABLE IF NOT EXISTS "backup_destinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text DEFAULT '' NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"bucket" text DEFAULT '' NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"accessKeyId" text DEFAULT '' NOT NULL,
	"secretAccessKey" text DEFAULT '' NOT NULL,
	"virtualHostedStyle" boolean DEFAULT false NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "backup_destinations_name_unique" ON "backup_destinations" ("name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"destinationId" integer NOT NULL REFERENCES "public"."backup_destinations"("id") ON DELETE restrict,
	"cron" text NOT NULL,
	"timeZone" text DEFAULT 'UTC' NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"includeAuditLog" boolean DEFAULT false NOT NULL,
	"includeSettingsHistory" boolean DEFAULT false NOT NULL,
	"keepLast" integer,
	"keepDays" integer,
	"passphrase" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"scheduledSince" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "backup_schedules_name_unique" ON "backup_schedules" ("name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"scheduleId" integer NOT NULL REFERENCES "public"."backup_schedules"("id") ON DELETE cascade,
	"slot" bigint NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"objectKey" text,
	"bytes" bigint,
	"durationMs" integer,
	"error" text,
	"errorCode" text,
	"replica" text,
	"startedAt" text NOT NULL,
	"finishedAt" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "backup_runs_schedule_slot_unique" ON "backup_runs" ("scheduleId", "slot");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_runs_started_at_idx" ON "backup_runs" ("startedAt");
