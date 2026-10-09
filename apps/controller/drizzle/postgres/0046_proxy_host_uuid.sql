-- Opaque host ids for URLs and the REST API; the serial id stays the key. gen_random_uuid() is core since PG 13.
ALTER TABLE "proxy_hosts" ADD COLUMN IF NOT EXISTS "uuid" text;--> statement-breakpoint
UPDATE "proxy_hosts" SET "uuid" = gen_random_uuid()::text WHERE "uuid" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proxy_hosts_uuid_unique" ON "proxy_hosts" ("uuid");--> statement-breakpoint
ALTER TABLE "l4_proxy_hosts" ADD COLUMN IF NOT EXISTS "uuid" text;--> statement-breakpoint
UPDATE "l4_proxy_hosts" SET "uuid" = gen_random_uuid()::text WHERE "uuid" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "l4_proxy_hosts_uuid_unique" ON "l4_proxy_hosts" ("uuid");
