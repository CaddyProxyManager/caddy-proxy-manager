import { getTranslations } from "next-intl/server";
import { extractErrorMessage } from "../actions";

/** A route's failure in the reader's words: a domain error by its code, anything else generically. */
export async function backupErrorMessage(error: unknown): Promise<string> {
  const [t, tErrors] = await Promise.all([getTranslations(), getTranslations("errors")]);
  return extractErrorMessage(t, error, tErrors("backupFailed"));
}
