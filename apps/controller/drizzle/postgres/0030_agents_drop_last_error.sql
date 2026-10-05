-- Nothing has written it since agents dial in: refusals, status problems and an offline agent each
-- have their own record, and a column every path only clears reads as "no errors".
ALTER TABLE "agents" DROP COLUMN IF EXISTS "lastError";
