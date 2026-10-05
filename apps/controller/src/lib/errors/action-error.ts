import type { useFormatter, useTranslations } from "next-intl";
import { DomainError, domainErrorOf, type StoredErrorCode } from "./domain-error";

export type ActionState = {
  status: "idle" | "success" | "error";
  message?: string;
};

export const INITIAL_ACTION_STATE: ActionState = { status: "idle" };

export function actionSuccess(message?: string): ActionState {
  return {
    status: "success",
    message,
  };
}

type Translator = ReturnType<typeof useTranslations>;

/** Which error code failed is only known at runtime; `tests/unit/domain-error.test.ts` covers it. */
type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Only a `DomainError`, or one an error carries, is translated; another Error keeps its English
 * and a non-Error gets the fallback. Pass `t` from `await getTranslations()`.
 */
export function actionError(t: Translator, error: unknown, fallbackMessage: string): ActionState {
  return {
    status: "error",
    message: extractErrorMessage(t, error, fallbackMessage),
  };
}

/** What a list param needs from next-intl's formatter; `await getFormatter()` is one. */
export type ListFormatter = Pick<ReturnType<typeof useFormatter>, "list">;

/** Without `format`, a list param is joined English-style, which is merely readable elsewhere. */
export function extractErrorMessage(
  t: Translator,
  error: unknown,
  fallbackMessage: string,
  format?: ListFormatter,
): string {
  const domain = domainErrorOf(error);
  if (domain) {
    // `params` has to come along: without it a code carrying placeholders renders them raw.
    const values: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(domain.params)) {
      values[name] =
        typeof value !== "object"
          ? value
          : format
            ? format.list(value, { type: "unit" })
            : value.join(", ");
    }
    return (t as unknown as DynamicTranslate)(`errors.${domain.code}`, values);
  }
  return error instanceof Error ? error.message : fallbackMessage;
}

/**
 * For failures a background job stored (update check, GeoIP updater): they have no reader, so they
 * store English plus the code when there is one; with no code the stored English is shown.
 */
export function storedErrorMessage(
  t: Translator,
  message: string,
  code: StoredErrorCode | null | undefined,
): string {
  if (!code) return message;
  return extractErrorMessage(t, new DomainError(code.code, code.params, message), message);
}
