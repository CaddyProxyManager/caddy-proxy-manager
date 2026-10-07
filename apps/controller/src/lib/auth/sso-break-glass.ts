/** The database half of auth/sso-enforcement.ts: the stored policy, and who a typed name is. */
import { and, inArray, or, sql } from "drizzle-orm";
import db from "../db";
import { users } from "../db/schema";
import { PORTAL_EMAIL_DOMAIN } from "./sign-in-names";
import type { SsoEnforcement } from "./sso-enforcement";

/** As a sign-in form reads a name: username, email, or the portal's `<name>@localhost`. */
export async function isBreakGlassName(policy: SsoEnforcement, name: string): Promise<boolean> {
  const typed = name.trim().toLowerCase();
  if (!typed || policy.breakGlassUserIds.length === 0) return false;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, policy.breakGlassUserIds),
        or(
          sql`lower(${users.username}) = ${typed}`,
          sql`lower(${users.email}) = ${typed}`,
          sql`lower(${users.email}) = ${typed + PORTAL_EMAIL_DOMAIN}`,
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Not cached and not caught: a sign-in reads the policy as stored, or does not happen. */
export async function getSsoEnforcement(): Promise<SsoEnforcement> {
  const { getSsoEnforcementSettings } = await import("../settings");
  return await getSsoEnforcementSettings();
}

/** For the Settings picker: accounts with a password of their own, which is what an exemption keeps. */
export async function listBreakGlassCandidates(): Promise<Array<{ id: number; label: string }>> {
  const { usersWithPassword } = await import("../models/user");
  const [rows, credential] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .orderBy(users.email),
    usersWithPassword(),
  ]);
  return rows
    .filter((row) => row.passwordHash || credential.has(row.id))
    .map((row) => ({ id: row.id, label: row.name ? `${row.name} (${row.email})` : row.email }));
}
