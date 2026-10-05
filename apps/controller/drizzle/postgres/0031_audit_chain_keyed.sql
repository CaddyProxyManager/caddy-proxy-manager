-- The chain is keyed and its head sealed; pre-chain events carry a mark instead of an id threshold.
-- A chain written before this is re-keyed at startup (prepareAuditChain).
ALTER TABLE "audit_chain" ADD COLUMN IF NOT EXISTS "legacyCount" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_chain" ADD COLUMN IF NOT EXISTS "seal" text;
--> statement-breakpoint
ALTER TABLE "audit_chain" DROP COLUMN IF EXISTS "legacyMaxId";
