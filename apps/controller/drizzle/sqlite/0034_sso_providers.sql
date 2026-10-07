-- SAML providers for the single sign-on plugin; CPM's half of each is its oauth_providers row.
CREATE TABLE `sso_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issuer` text NOT NULL,
	`oidcConfig` text,
	`samlConfig` text,
	`userId` integer,
	`providerId` text NOT NULL,
	`organizationId` text,
	`domain` text DEFAULT '' NOT NULL,
	`domainVerified` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`providerId`) REFERENCES `oauth_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_providers_provider_unique` ON `sso_providers` (`providerId`);