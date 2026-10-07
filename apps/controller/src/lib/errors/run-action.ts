/**
 * Every server action's body runs in here, or in a `try` whose `catch` returns:
 * `tests/unit/errors/server-action-errors.test.ts` holds each one to that.
 */
import { unstable_rethrow } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { extractErrorMessage } from "./action-error";
import type { ActionResult } from "./action-result";
import { domainErrorOf } from "./domain-error";

/** `redirect()` and `notFound()` still throw, as the framework needs them to. */
export async function runAction<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    unstable_rethrow(error);
    // The framework logged these while they were thrown; now only this sees them.
    if (!domainErrorOf(error)) console.error("Server action failed:", error);
    // For list params, such as the hosts still using a CA being deleted.
    const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
    return {
      ok: false,
      error: extractErrorMessage(t, error, t("common.somethingWentWrong"), format),
    };
  }
}
