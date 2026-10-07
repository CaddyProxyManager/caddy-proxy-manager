-- Access reviews: campaigns and the items each asks its reviewers about.
CREATE TABLE IF NOT EXISTS "access_review_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"scopeRef" text,
	"dueOn" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"createdBy" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"closedBy" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"closedAt" text,
	"appliedBy" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"appliedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "access_review_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaignId" integer NOT NULL REFERENCES "public"."access_review_campaigns"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"userId" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"groupId" integer REFERENCES "public"."groups"("id") ON DELETE set null,
	"tokenId" integer REFERENCES "public"."api_tokens"("id") ON DELETE set null,
	"connectionId" integer REFERENCES "public"."scim_connections"("id") ON DELETE set null,
	"objectKind" text,
	"objectId" integer,
	"subjectLabel" text NOT NULL,
	"targetLabel" text,
	"current" text,
	"hints" text DEFAULT '[]' NOT NULL,
	"scimManaged" boolean DEFAULT false NOT NULL,
	"reviewerId" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"decision" text,
	"changeTo" text,
	"note" text,
	"decidedBy" integer REFERENCES "public"."users"("id") ON DELETE set null,
	"decidedAt" text,
	"outcome" text,
	"outcomeCode" text,
	"appliedAt" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_review_items_campaign_idx" ON "access_review_items" ("campaignId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_review_items_reviewer_idx" ON "access_review_items" ("reviewerId");
