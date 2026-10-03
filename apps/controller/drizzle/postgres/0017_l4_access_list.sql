-- L4 hosts can use an access list's IP rules.
ALTER TABLE "l4_proxy_hosts" ADD COLUMN IF NOT EXISTS "accessListId" integer REFERENCES "access_lists"("id") ON DELETE set null;
