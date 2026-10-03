-- Better Auth's passkey plugin: one row per WebAuthn credential.
CREATE TABLE IF NOT EXISTS "passkeys" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text,
  "publicKey" text NOT NULL,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "credentialID" text NOT NULL,
  "counter" integer NOT NULL,
  "deviceType" text NOT NULL,
  "backedUp" boolean NOT NULL,
  "transports" text,
  "aaguid" text,
  "createdAt" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "passkeys_credential_unique" ON "passkeys" ("credentialID");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkeys_user_idx" ON "passkeys" ("userId");
