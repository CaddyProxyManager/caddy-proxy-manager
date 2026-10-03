-- Certificates an agent reads from files on its host.
ALTER TABLE `certificates` ADD `source` text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE `certificates` ADD `sourceAgentId` integer REFERENCES agents(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `certificates` ADD `sourceCertPath` text;--> statement-breakpoint
ALTER TABLE `certificates` ADD `sourceKeyPath` text;--> statement-breakpoint
ALTER TABLE `certificates` ADD `sourceReadAt` text;--> statement-breakpoint
ALTER TABLE `certificates` ADD `sourceError` text;