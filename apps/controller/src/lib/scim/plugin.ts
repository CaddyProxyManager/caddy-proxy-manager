/**
 * SCIM 2.0 through @better-auth/scim, at /api/auth/scim/v2, PostgreSQL only: the plugin needs
 * interactive transactions, which bun:sqlite cannot give an async body. It runs in its own Better
 * Auth instance (./auth.ts), so only SCIM's writes are transactional. CPM adds what the plugin
 * leaves to its host: its own connections and tokens, linking to accounts that already exist,
 * what deprovisioning revokes, and the provisioned groups as CPM groups with roles.
 */
import { scim } from "@better-auth/scim";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { schemaDialect } from "../db/schema";
import { nowIso } from "../db";
import { SCIM_ERROR_SCHEMA, ScimError } from "./errors";
import { authenticateScimToken, linksExistingAccounts, mappedGroupRole } from "./connections";

export const SCIM_PATH = "/scim/v2/";
/** One domain: a person provisioned by two identity providers is one CPM account. */
export const SCIM_DOMAIN = "cpm";
/** The grant every provisioned group projects, so groups no role is mapped to still arrive. */
export const MEMBER_ROLE = "member";
const ALL_SCOPES = [
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
] as const;

export function scimSupported(): boolean {
  return schemaDialect === "postgres";
}

function scimApiError(status: 400 | 409, scimType: string, detail: string): APIError {
  const error = new APIError(status === 400 ? "BAD_REQUEST" : "CONFLICT", {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    scimType,
    detail,
  });
  error.message = detail;
  return error;
}

// biome-ignore lint/suspicious/noExplicitAny: the plugin's transaction adapter, untyped here
type Database = any;

type Grant = { source: { id: string; displayName: string }; role: string };

/**
 * Disabling takes everything the account could still act with: the plugin ends its sessions, and
 * this its API tokens and forward-auth sessions, in the same transaction. An account the identity
 * provider deleted is disabled too; one whose connection was deleted (its SCIM rows outlive it,
 * retired) is left as it is.
 */
async function reconcileAccount(
  state: { userId: string; active: boolean; sources: readonly unknown[] },
  database: Database,
): Promise<void> {
  const userId = Number(state.userId);
  if (state.sources.length === 0) {
    const retired = await database.findOne({
      model: "scimUser",
      where: [{ field: "userId", value: userId }],
    });
    if (retired) return;
  }
  const user = await database.findOne({ model: "user", where: [{ field: "id", value: userId }] });
  if (!user) return;
  const status = state.active ? "active" : "disabled";
  if (user.status === status) return;
  if (!state.active && user.role === "admin") {
    const admins = await database.count({
      model: "user",
      where: [
        { field: "role", value: "admin" },
        { field: "status", value: "active" },
      ],
    });
    if (admins <= 1) {
      throw scimApiError(400, "mutability", "The last active administrator cannot be disabled");
    }
  }
  await database.update({
    model: "user",
    where: [{ field: "id", value: userId }],
    update: { status, updatedAt: new Date() },
  });
  if (!state.active) {
    await database.deleteMany({
      model: "cpmApiToken",
      where: [{ field: "createdBy", value: userId }],
    });
    await database.deleteMany({
      model: "cpmForwardAuthSession",
      where: [{ field: "userId", value: userId }],
    });
  }
}

/** A provisioned group's CPM twin, made or renamed to match; its role from the mapping. */
async function mirrorGroup(database: Database, grant: Grant): Promise<number> {
  const role = grant.role === MEMBER_ROLE ? null : grant.role;
  const now = nowIso();
  const existing = await database.findOne({
    model: "cpmGroup",
    where: [{ field: "scimGroupId", value: grant.source.id }],
  });
  if (existing) {
    if (existing.name !== grant.source.displayName || existing.role !== role) {
      await database.update({
        model: "cpmGroup",
        where: [{ field: "id", value: Number(existing.id) }],
        update: { name: grant.source.displayName, role, updatedAt: now },
      });
    }
    return Number(existing.id);
  }
  const taken = await database.findOne({
    model: "cpmGroup",
    where: [{ field: "name", value: grant.source.displayName }],
  });
  if (taken) {
    throw scimApiError(
      409,
      "uniqueness",
      `A group named ${grant.source.displayName} already exists`,
    );
  }
  const created = await database.create({
    model: "cpmGroup",
    data: {
      name: grant.source.displayName,
      source: "scim",
      role,
      scimGroupId: grant.source.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  return Number(created.id);
}

/** The account's provisioned-group memberships, made to match its grants. Other groups stay. */
async function projectGroups(
  state: { userId: string; grants: readonly Grant[] },
  database: Database,
): Promise<void> {
  const userId = Number(state.userId);
  const wanted = new Set<number>();
  for (const grant of state.grants) wanted.add(await mirrorGroup(database, grant));
  const memberships = await database.findMany({
    model: "cpmGroupMember",
    where: [{ field: "userId", value: userId }],
  });
  const heldIds = memberships.map((membership: { groupId: string | number }) =>
    Number(membership.groupId),
  );
  const mirrored = new Set(
    heldIds.length === 0
      ? []
      : (
          await database.findMany({
            model: "cpmGroup",
            where: [
              { field: "id", value: heldIds, operator: "in" },
              { field: "source", value: "scim" },
            ],
          })
        ).map((group: { id: string | number }) => Number(group.id)),
  );
  const held = new Set<number>();
  for (const membership of memberships) {
    const groupId = Number(membership.groupId);
    held.add(groupId);
    if (mirrored.has(groupId) && !wanted.has(groupId)) {
      await database.delete({
        model: "cpmGroupMember",
        where: [{ field: "id", value: Number(membership.id) }],
      });
    }
  }
  for (const groupId of wanted) {
    if (held.has(groupId)) continue;
    await database.create({
      model: "cpmGroupMember",
      data: { groupId, userId, createdAt: nowIso() },
    });
  }
}

/**
 * Tables CPM owns that the SCIM hooks write inside the plugin's transaction, declared so its
 * adapter can reach them; nothing else uses these names.
 */
const CPM_MODELS = {
  cpmGroup: {
    modelName: "groups",
    fields: {
      name: { type: "string" },
      source: { type: "string" },
      role: { type: "string", required: false },
      scimGroupId: { type: "string", required: false },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
  },
  cpmGroupMember: {
    modelName: "groupMembers",
    fields: {
      groupId: { type: "number" },
      userId: { type: "number" },
      createdAt: { type: "string" },
    },
  },
  // Only ever deleted from; the rest of each row is declared for the adapter's schema check.
  cpmApiToken: {
    modelName: "apiTokens",
    fields: {
      createdBy: { type: "number" },
      name: { type: "string" },
      tokenHash: { type: "string" },
      createdAt: { type: "string" },
    },
  },
  cpmForwardAuthSession: {
    modelName: "forwardAuthSessions",
    fields: {
      userId: { type: "number" },
      proxyHostId: { type: "number" },
      audienceOrigin: { type: "string" },
      tokenHash: { type: "string" },
      expiresAt: { type: "string" },
      createdAt: { type: "string" },
    },
  },
} as const;

export function scimResponse(error: ScimError): Response {
  return new Response(JSON.stringify(error), {
    status: error.status,
    headers: { "content-type": "application/scim+json" },
  });
}

/** A weak version from lastModified: the plugin answers no meta.version, and ETags stay off. */
function withVersion(resource: unknown): void {
  const meta = (resource as { meta?: { lastModified?: string | Date; version?: string } } | null)
    ?.meta;
  if (!meta?.lastModified || meta.version) return;
  meta.version = `W/"${new Date(meta.lastModified).getTime()}"`;
}

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * What CPM puts around the plugin in its own instance: the endpoints it leaves out (/Me, /Bulk)
 * answer 501, resources gain meta.version, and a write is audited and reaches the group's CPM twin.
 */
export function scimExtras(): BetterAuthPlugin {
  return {
    id: "cpm-scim-extras",
    schema: CPM_MODELS as unknown as BetterAuthPlugin["schema"],
    async onRequest(request) {
      const { pathname } = new URL(request.url);
      if (!pathname.includes(SCIM_PATH)) return;
      const endpoint = pathname.slice(pathname.indexOf(SCIM_PATH) + SCIM_PATH.length);
      if (/^(Me|Bulk)(\/|$)/.test(endpoint)) {
        return { response: scimResponse(new ScimError(501, `/${endpoint} is not supported`)) };
      }
    },
    hooks: {
      after: [
        {
          matcher: (ctx) => (ctx.path ?? "").startsWith("/scim/v2/"),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as { Resources?: unknown[] } | null;
            if (!returned || typeof returned !== "object" || returned instanceof Error) return;
            if (Array.isArray(returned.Resources)) returned.Resources.forEach(withVersion);
            else withVersion(returned);
          }),
        },
        {
          matcher: (ctx) =>
            /^\/scim\/v2\/(Users|Groups)(\/|$)/.test(ctx.path ?? "") &&
            WRITES.has(ctx.request?.method ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (returned instanceof Error) return;
            const kind = ctx.path.startsWith("/scim/v2/Users") ? "user" : "group";
            const params = (ctx.params ?? {}) as { userId?: string; groupId?: string };
            const resource =
              returned && typeof returned === "object" && !(returned instanceof Response)
                ? (returned as { id?: string })
                : null;
            const resourceId = params.userId ?? params.groupId ?? resource?.id ?? null;
            const token = /^Bearer\s+(\S+)/i.exec(ctx.request?.headers.get("authorization") ?? "");
            const { auditScimWrite, syncGroupMirror } = await import("./mirror");
            if (kind === "group" && resourceId) await syncGroupMirror(resourceId);
            await auditScimWrite({
              method: ctx.request?.method ?? "",
              kind,
              token: token?.[1] ?? null,
              resource,
              resourceId,
            });
          }),
        },
      ],
    },
  };
}

export function scimProvisioning(): BetterAuthPlugin {
  return scim({
    connections: [],
    authentication: {
      async verifyBearerToken({ token }) {
        const connection = await authenticateScimToken(token);
        if (!connection) return null;
        return {
          connection: { id: String(connection.id), provisioningDomainId: SCIM_DOMAIN },
          credentialId: `connection-${connection.id}`,
          scopes: ALL_SCOPES,
        };
      },
    },
    identity: {
      // An existing account is taken over only where the connection allows it; its profile stays.
      async resolveUser(input) {
        if (!(await linksExistingAccounts(Number(input.connectionId)))) return { action: "create" };
        const email = input.resource.primaryEmail.trim().toLowerCase();
        const { findUserByEmail } = await import("../models/user");
        const existing = await findUserByEmail(email);
        return existing
          ? { action: "link", userId: String(existing.id), profile: "preserve" }
          : { action: "create" };
      },
      reconcileUser: (state, { database }) => reconcileAccount(state, database),
    },
    projection: {
      roles: {
        async map({ connectionId, source }) {
          return [(await mappedGroupRole(Number(connectionId), source.displayName)) ?? MEMBER_ROLE];
        },
        async exists({ role }) {
          if (role === MEMBER_ROLE) return true;
          if (role === "admin") return false;
          const { isKnownRole } = await import("../roles/store");
          return isKnownRole(role);
        },
      },
      reconcileUser: (state, { database }) => projectGroups(state, database),
    },
    compatibility: { microsoftEntra: { acceptLegacyGroupSchema: true } },
  }) as unknown as BetterAuthPlugin;
}
