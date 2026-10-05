/** The audit log's filter choices, held by models/audit.ts and fed by every chained insert. */
import { peekProcessMemo } from "../settings/process-memo";

export const AUDIT_FILTER_OPTIONS = "audit-filter-options";

type Known = { entityTypes: Set<string>; actions: Set<string> };

/** A rolled-back insert leaves a choice that matches nothing, which filters to an empty page. */
export function noteAuditFilterValues(rows: { entityType: string; action: string }[]): void {
  const held = peekProcessMemo<Known>(AUDIT_FILTER_OPTIONS);
  if (!held) return;
  void held.then(
    (known) => {
      for (const row of rows) {
        known.entityTypes.add(row.entityType);
        known.actions.add(row.action);
      }
    },
    () => {},
  );
}
