import { eq } from "drizzle-orm";
import db, { nowIso } from "../db";
import { settings } from "../db/schema";
import { DEFAULT_TABLE_DENSITY, isTableDensity, type TableDensity } from "../table-density";

/** Written straight to the table: setSetting would stage a personal choice for Review & apply. */
const keyFor = (userId: number) => `ui:table_density:${userId}`;

/** The default when unset or unreadable. */
export async function getTableDensity(userId: number): Promise<TableDensity> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, keyFor(userId)))
    .limit(1);
  return isTableDensity(row?.value) ? row.value : DEFAULT_TABLE_DENSITY;
}

export async function setTableDensity(userId: number, density: TableDensity): Promise<void> {
  const now = nowIso();
  await db
    .insert(settings)
    .values({ key: keyFor(userId), value: density, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: density, updatedAt: now } });
}
