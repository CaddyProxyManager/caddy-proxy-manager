/**
 * For actions that return data, so cannot use `actionError()`: only the server reaches the
 * catalog. Anything else is rethrown untouched, which keeps `redirect()` working.
 */
import { getFormatter, getTranslations } from "next-intl/server";
import { DomainError } from "./domain-error";
import { extractErrorMessage } from "./actions";

export async function withTranslatedErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // For list params, such as the hosts still using a CA being deleted.
    const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
    throw new Error(extractErrorMessage(t, error, error.message, format));
  }
}
