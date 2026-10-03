-- Better Auth's passkey plugin: one row per WebAuthn credential.
CREATE TABLE `passkeys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`publicKey` text NOT NULL,
	`userId` integer NOT NULL,
	`credentialID` text NOT NULL,
	`counter` integer NOT NULL,
	`deviceType` text NOT NULL,
	`backedUp` integer NOT NULL,
	`transports` text,
	`aaguid` text,
	`createdAt` text,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_unique` ON `passkeys` (`credentialID`);--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`userId`);