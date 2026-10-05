/**
 * The updater runs with no reader, so it stores English plus a code (see `storedErrorMessage`);
 * these render them in the settings page reader's language.
 */

import { storedErrorMessage } from "../errors/action-error";
import type { GeoipDownloadFailure, GeoipUpdateResult } from "./updater";

type Translator = Parameters<typeof storedErrorMessage>[0];

function editionFailureMessage(t: Translator, failure: GeoipDownloadFailure): string {
  // Narrowed by hand: one literal key against the whole root catalog is more than tsc will
  // instantiate. The catalog test checks `settings.geoipEditionDownloadFailed` instead.
  const translate = t as unknown as (key: string, values: Record<string, string>) => string;
  return translate("settings.geoipEditionDownloadFailed", {
    edition: failure.edition,
    reason: storedErrorMessage(t, failure.message, failure.code),
  });
}

/** Why the last download failed, or null. `joined` is the English a state stored earlier holds. */
export function geoipDownloadErrorMessage(
  t: Translator,
  joined: string | null,
  failures: readonly GeoipDownloadFailure[],
): string | null {
  if (!joined) return null;
  if (failures.length === 0) return joined;
  return failures.map((failure) => editionFailureMessage(t, failure)).join("; ");
}

export function geoipUpdateErrorMessage(t: Translator, result: GeoipUpdateResult): string | null {
  if (!result.error) return null;
  const parts: string[] = [];
  if (result.checkError) {
    parts.push(storedErrorMessage(t, result.checkError.message, result.checkError.code));
  }
  for (const failure of result.failures ?? []) parts.push(editionFailureMessage(t, failure));
  // Empty when the run itself threw: its English is all there is.
  return parts.length > 0 ? parts.join("; ") : result.error;
}
