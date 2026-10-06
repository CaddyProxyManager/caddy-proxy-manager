-- The leader's MaxMind downloads, stored for the other replicas to install.
CREATE TABLE IF NOT EXISTS "geoip_databases" (
	"edition" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"data" bytea NOT NULL,
	"updatedAt" text NOT NULL
);
