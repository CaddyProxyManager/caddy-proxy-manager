/**
 * SQLite is meant for legacy installs and demos. The banner dismisses for a while, not for good:
 * the advice stays true.
 */
import { schemaDialect } from "./db/schema";
import { isDemoMode } from "./demo-mode";

export { SQLITE_NOTICE_COOKIE, SQLITE_NOTICE_DISMISS_SECONDS } from "./sqlite-notice-cookie";

/** A demo is what SQLite is for. */
export function sqliteNoticeApplies(): boolean {
  return schemaDialect === "sqlite" && !isDemoMode();
}
