-- Certificates an agent reads from files on its host.
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "sourceAgentId" integer REFERENCES "agents"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "sourceCertPath" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "sourceKeyPath" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "sourceReadAt" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "sourceError" text;
