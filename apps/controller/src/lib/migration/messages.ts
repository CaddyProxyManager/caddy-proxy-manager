/**
 * The migration screen's `setup.migrationGroups.*` lookups. selection.ts keeps the English, as the
 * importer and API share it with no translator; keys are runtime ids, so
 * tests/unit/migration-messages.test.ts checks coverage.
 */

import type { useTranslations } from "next-intl";
import type { MigrationGroupId } from "./selection";

type SetupTranslator = ReturnType<typeof useTranslations<"setup">>;

/** The one place the narrowing is given up, for the reason in the header comment. */
type DynamicTranslate = (key: string) => string;

function dynamic(t: SetupTranslator): DynamicTranslate {
  return t as unknown as DynamicTranslate;
}

export function migrationGroupLabel(t: SetupTranslator, id: MigrationGroupId): string {
  return dynamic(t)(`migrationGroups.${id}.label`);
}

export function migrationGroupDescription(t: SetupTranslator, id: MigrationGroupId): string {
  return dynamic(t)(`migrationGroups.${id}.description`);
}
