-- Change approvals: writes held until approvers agree, and each approver's decision.
CREATE TABLE IF NOT EXISTS "change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"area" text NOT NULL,
	"targetType" text,
	"targetId" integer,
	"targetName" text,
	"payload" text NOT NULL,
	"preview" text NOT NULL,
	"baseState" text NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"requiredApprovals" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requestedBy" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"requestedByName" text,
	"viaToken" boolean DEFAULT false NOT NULL,
	"bypassedBy" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"bypassedByName" text,
	"bypassReason" text,
	"resultCode" text,
	"error" text,
	"createdAt" text NOT NULL,
	"decidedAt" text,
	"appliedAt" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_requests_status_idx" ON "change_requests" ("status","id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "change_request_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"requestId" integer NOT NULL REFERENCES "public"."change_requests"("id") ON DELETE cascade,
	"userId" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"userName" text,
	"decision" text NOT NULL,
	"note" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_request_decisions_once" ON "change_request_decisions" ("requestId","userId");
