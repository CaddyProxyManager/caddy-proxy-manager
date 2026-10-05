/**
 * Second-factor checks for the forward-auth portal, which has no Better Auth session for the
 * plugin's `/two-factor/verify-*` routes. Same row, key, TOTP parameters and failure budget as
 * the plugin, so the two sign-ins can't drift apart.
 */

// Pinned in package.json to the exact version better-auth depends on, so both check codes alike.
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import db from "../db";
import { twoFactors, users } from "../db/schema";
import { config } from "../config";

/** Better Auth's defaults, repeated because the portal has to enforce the same budget. */
export const TWO_FACTOR_MAX_FAILURES = 10;
export const TWO_FACTOR_LOCK_MS = 15 * 60 * 1000;
const TOTP = { digits: 6, period: 30 } as const;

export type SecondFactorMethod = "totp" | "backup";
export type SecondFactorResult = "ok" | "invalid" | "locked" | "notEnabled";

// What Better Auth encrypts the plugin's columns with: `createAuth` passes this as its only secret.
async function secretKey(): Promise<string> {
  return config.sessionSecret;
}

export async function verifySecondFactor(
  userId: number,
  method: SecondFactorMethod,
  code: string,
): Promise<SecondFactorResult> {
  const row = await db.query.twoFactors.findFirst({
    where: (table, operators) => operators.eq(table.userId, userId),
  });
  if (!row || row.verified === false) return "notEnabled";
  if (row.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now()) return "locked";

  const key = await secretKey();
  const trimmed = code.replace(/\s+/g, "");
  let ok = false;
  if (method === "totp") {
    const secret = await symmetricDecrypt({ key, data: row.secret });
    ok = await createOTP(secret, TOTP).verify(trimmed);
  } else {
    const codes = JSON.parse(await symmetricDecrypt({ key, data: row.backupCodes }));
    if (Array.isArray(codes) && codes.includes(trimmed)) {
      const remaining = codes.filter((candidate: unknown) => candidate !== trimmed);
      // Compare-and-swap on the list we read: a concurrent use of the same code matches no row.
      const spent = await db
        .update(twoFactors)
        .set({
          backupCodes: await symmetricEncrypt({ key, data: JSON.stringify(remaining) }),
        })
        .where(and(eq(twoFactors.id, row.id), eq(twoFactors.backupCodes, row.backupCodes)))
        .returning({ id: twoFactors.id });
      ok = spent.length > 0;
    }
  }

  if (ok) {
    await db
      .update(twoFactors)
      .set({ failedVerificationCount: 0, lockedUntil: null })
      .where(eq(twoFactors.id, row.id));
    return "ok";
  }
  const [updated] = await db
    .update(twoFactors)
    .set({ failedVerificationCount: sql`${twoFactors.failedVerificationCount} + 1` })
    .where(eq(twoFactors.id, row.id))
    .returning({ count: twoFactors.failedVerificationCount });
  if ((updated?.count ?? 0) >= TWO_FACTOR_MAX_FAILURES) {
    await db
      .update(twoFactors)
      .set({ lockedUntil: new Date(Date.now() + TWO_FACTOR_LOCK_MS).toISOString() })
      .where(eq(twoFactors.id, row.id));
  }
  return "invalid";
}

export async function resetTwoFactor(userId: number): Promise<boolean> {
  const deleted = await db.delete(twoFactors).where(eq(twoFactors.userId, userId)).returning();
  await db.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, userId));
  return deleted.length > 0;
}
