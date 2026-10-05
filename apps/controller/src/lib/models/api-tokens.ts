import { createHash, randomBytes } from "node:crypto";
import db, { nowIso, toIso } from "../db";
import { apiTokens } from "../db/schema";
import { and, count, eq } from "drizzle-orm";
import { NotFoundError } from "../api/auth";
import { domainError } from "../errors/domain-error";
import { logAuditEvent } from "../audit";
import { mfaStandingForAccount } from "../auth/two-factor/policy";
import {
  FULL_SCOPE,
  type TokenPermission,
  type TokenScope,
  type TokenScopeKind,
  flattenScope,
  scopeFromColumns,
  scopeToColumns,
} from "../api-tokens/scope";

export type ApiToken = {
  id: number;
  name: string;
  createdBy: number;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** Narrows the owner's role; never widens it. See `unflattenScope`. */
  scope: TokenScopeKind;
  permissions: TokenPermission[];
};

type ApiTokenRow = typeof apiTokens.$inferSelect;

function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt)!,
    lastUsedAt: row.lastUsedAt ? toIso(row.lastUsedAt) : null,
    expiresAt: row.expiresAt ? toIso(row.expiresAt) : null,
    ...flattenScope(scopeFromColumns(row.scope, row.permissions)),
  };
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export const MAX_TOKENS_PER_USER = 10;

async function tokenCount(userId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(apiTokens)
    .where(eq(apiTokens.createdBy, userId));
  return Number(row?.value ?? 0);
}

function accountOf(user: {
  id: number;
  role: string;
  passwordHash: string | null;
  twoFactorEnabled: boolean;
}) {
  return {
    id: user.id,
    role: user.role,
    hasPassword: Boolean(user.passwordHash),
    twoFactorEnabled: user.twoFactorEnabled,
  };
}
const MAX_TOKEN_NAME_LENGTH = 100;

export async function createApiToken(
  name: string,
  createdBy: number,
  expiresAt?: string,
  scope: TokenScope = FULL_SCOPE,
): Promise<{ token: ApiToken; rawToken: string }> {
  const trimmedName = name.trim();
  if (trimmedName.length > MAX_TOKEN_NAME_LENGTH) {
    throw domainError("apiTokenNameTooLong", { max: MAX_TOKEN_NAME_LENGTH }, { status: 400 });
  }

  // A token outlives a grace period, so one is minted only once the second factor is there.
  const owner = await db.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, createdBy),
  });
  if (owner) {
    const standing = await mfaStandingForAccount(accountOf(owner));
    if (standing.status === "grace" || standing.status === "required") {
      throw domainError("apiTokenNeedsSecondFactor", {}, { status: 403 });
    }
  }

  if ((await tokenCount(createdBy)) >= MAX_TOKENS_PER_USER) {
    throw domainError("apiTokenLimitReached", { max: MAX_TOKENS_PER_USER }, { status: 400 });
  }

  let validatedExpiresAt: string | null = null;
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw domainError("tokenExpiryInvalid");
    }
    if (parsed <= new Date()) {
      throw domainError("tokenExpiryInPast");
    }
    validatedExpiresAt = parsed.toISOString();
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const now = nowIso();

  const [row] = await db
    .insert(apiTokens)
    .values({
      name: name.trim(),
      tokenHash,
      createdBy,
      createdAt: now,
      expiresAt: validatedExpiresAt,
      ...scopeToColumns(scope),
    })
    .returning();

  if (!row) {
    throw domainError("failedToCreateApiToken");
  }
  // Counted again once inserted, so two creates racing past the check above cannot both stay:
  // whichever counts last sees both rows.
  if ((await tokenCount(createdBy)) > MAX_TOKENS_PER_USER) {
    await db.delete(apiTokens).where(eq(apiTokens.id, row.id));
    throw domainError("apiTokenLimitReached", { max: MAX_TOKENS_PER_USER }, { status: 400 });
  }

  const token = toApiToken(row);
  await logAuditEvent({
    userId: createdBy,
    action: "create",
    entityType: "api_token",
    entityId: token.id,
    summary: `Created API token ${token.name}`,
    data: { scope: token.scope, permissions: token.permissions, expiresAt: token.expiresAt },
  });
  return { token, rawToken };
}

export async function listApiTokens(userId: number): Promise<ApiToken[]> {
  const rows = await db.query.apiTokens.findMany({
    where: (table, { eq }) => eq(table.createdBy, userId),
    orderBy: (table, { desc }) => desc(table.createdAt),
  });
  return rows.map(toApiToken);
}

export async function listAllApiTokens(): Promise<ApiToken[]> {
  const rows = await db.query.apiTokens.findMany({
    orderBy: (table, { desc }) => desc(table.createdAt),
  });
  return rows.map(toApiToken);
}

export async function deleteApiToken(
  id: number,
  userId: number,
  canDeleteAny = false,
): Promise<void> {
  // Authorization is in the DELETE predicate, so status codes cannot enumerate others' token ids.
  const deleted = await db
    .delete(apiTokens)
    .where(
      canDeleteAny
        ? eq(apiTokens.id, id)
        : and(eq(apiTokens.id, id), eq(apiTokens.createdBy, userId)),
    )
    .returning({ id: apiTokens.id, name: apiTokens.name });

  if (deleted.length === 0) {
    throw new NotFoundError("Token not found");
  }
  await logAuditEvent({
    userId,
    action: "delete",
    entityType: "api_token",
    entityId: id,
    summary: `Deleted API token ${deleted[0].name}`,
  });
}

const LAST_USED_DEBOUNCE_MS = 60_000; // 60 seconds

export async function validateToken(rawToken: string): Promise<{
  token: ApiToken;
  user: { id: number; role: string; hasPassword: boolean; twoFactorEnabled: boolean };
} | null> {
  const tokenHash = hashToken(rawToken);

  const row = await db.query.apiTokens.findFirst({
    where: (table, { eq }) => eq(table.tokenHash, tokenHash),
  });

  if (!row) {
    return null;
  }

  if (row.expiresAt) {
    const expiresAt = new Date(row.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      return null;
    }
  }

  const user = await db.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, row.createdBy),
  });

  if (user?.status !== "active") {
    return null;
  }

  const now = new Date();
  const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt) : null;
  if (!lastUsed || now.getTime() - lastUsed.getTime() > LAST_USED_DEBOUNCE_MS) {
    await db.update(apiTokens).set({ lastUsedAt: nowIso() }).where(eq(apiTokens.id, row.id));
  }

  return {
    token: toApiToken(row),
    user: accountOf(user),
  };
}
