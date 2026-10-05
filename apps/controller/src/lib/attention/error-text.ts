/** An item's error in the reader's language, from the codes it carries. Client safe. */
import { storedErrorMessage } from "../errors/action-error";
import type { AttentionError } from "./types";

type Translator = Parameters<typeof storedErrorMessage>[0];

export function attentionErrorText(t: Translator, errors: readonly AttentionError[]): string {
  // Narrowed by hand, as lib/geoip/messages.ts does: one literal key against the root catalog.
  const translate = t as unknown as (key: string, values: Record<string, string>) => string;
  return errors
    .map((error) => {
      const reason = storedErrorMessage(t, error.message, error.code);
      return error.edition
        ? translate("settings.geoipEditionDownloadFailed", { edition: error.edition, reason })
        : reason;
    })
    .join("; ");
}
