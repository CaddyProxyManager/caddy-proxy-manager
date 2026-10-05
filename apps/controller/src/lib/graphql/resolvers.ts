/**
 * Every resolver calls the model function its `/api/v1/` route calls, so GraphQL and REST cannot
 * disagree - the parity tests assert it. Users and certificates are projected to named fields, so a
 * future secret column cannot leak; the rest is returned whole, extras gathered into `config`.
 */

import { applyCaddyConfig as applyCaddy } from "../caddy";
import { DNS_PROVIDERS } from "../dns/providers";
import { getCaddyModuleAvailability } from "../caddy/image-build";
import {
  listAccessLists,
  getAccessList,
  createAccessList,
  updateAccessList,
  deleteAccessList,
} from "../models/access-lists";
import { isConnected } from "../agent/registry";
import { type PairedAgent, listAgents } from "../models/agents";
import { createApiToken, deleteApiToken, listApiTokens } from "../models/api-tokens";
import { countAuditEvents, listAuditEvents } from "../models/audit";
import { listCaCertificates } from "../models/ca-certificates";
import { listCertificates, getCertificate } from "../models/certificates";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "../models/groups";
import { listIssuedClientCertificates } from "../models/issued-client-certificates";
import {
  createL4ProxyHost,
  deleteL4ProxyHost,
  getL4ProxyHost,
  listL4ProxyHosts,
  updateL4ProxyHost,
} from "../models/l4-proxy-hosts";
import { listMtlsRoles } from "../models/mtls-roles";
import { listOAuthProviders } from "../models/oauth-providers";
import {
  createProxyHost,
  deleteProxyHost,
  getProxyHost,
  listProxyHosts,
  updateProxyHost,
} from "../models/proxy-hosts";
import {
  bulkUpdateL4ProxyHosts,
  bulkUpdateProxyHosts,
  parseL4HostBulkRequest,
  parseProxyHostBulkRequest,
} from "../models/bulk-hosts";
import { deleteUser, getUserById, listUsers, updateUserRole } from "../models/user";
import { ApiAuthError, NotFoundError } from "../api/auth";
import { isSettingsGroup, readSettingsGroup, saveSettingsGroup } from "../settings/api";
import { assertNotSelf, assertUserRole } from "../users/admin";
import { type GraphQLContext, requireAdmin } from "./context";
import { DateTimeScalar, JSONScalar } from "./scalars";

/** The rest becomes `config`. */
const PROXY_HOST_SCALAR_FIELDS = new Set([
  "id",
  "name",
  "description",
  "domains",
  "upstreams",
  "enabled",
  "certificateId",
  "accessListId",
  "sslForced",
  "hstsEnabled",
  "hstsSubdomains",
  "allowWebsocket",
  "preserveHostHeader",
  "skipHttpsHostnameValidation",
  "createdAt",
  "updatedAt",
]);

const L4_SCALAR_FIELDS = new Set([
  "id",
  "name",
  "description",
  "protocol",
  "listenAddress",
  "upstreams",
  "matcherType",
  "matcherValue",
  "tlsTermination",
  "proxyProtocolVersion",
  "proxyProtocolReceive",
  "accessListId",
  "enabled",
  "createdAt",
  "updatedAt",
]);

/** As `/api/v1/audit-log`, so neither API can be asked for the whole table. */
const MAX_AUDIT_LOG_LIMIT = 200;

function remainder(row: Record<string, unknown>, promoted: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !promoted.has(key)));
}

type CertificateRow = Awaited<ReturnType<typeof listCertificates>>[number];
type UserRow = Awaited<ReturnType<typeof listUsers>>[number];

/** The row carries a private key. */
function projectCertificate(row: CertificateRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    domainNames: row.domainNames,
    autoRenew: row.autoRenew,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: row.source,
    sourceAgentId: row.sourceAgentId,
    sourceCertPath: row.sourceCertPath,
    sourceKeyPath: row.sourceKeyPath,
    sourceReadAt: row.sourceReadAt,
    sourceError: row.sourceError,
  };
}

/** The row carries a password hash and the OAuth subject. */
function projectUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    provider: row.provider,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const resolvers = {
  JSON: JSONScalar,
  DateTime: DateTimeScalar,

  ProxyHost: {
    config: (host: Record<string, unknown>) => remainder(host, PROXY_HOST_SCALAR_FIELDS),
  },
  L4ProxyHost: {
    config: (host: Record<string, unknown>) => remainder(host, L4_SCALAR_FIELDS),
  },
  Agent: {
    // Not a column: whether this process holds the agent's stream (lib/agent/registry.ts).
    connected: (agent: PairedAgent) => isConnected(agent.agentId),
  },

  Query: {
    proxyHosts: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listProxyHosts();
    },
    proxyHost: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      await requireAdmin(context);
      return await getProxyHost(args.id);
    },
    l4ProxyHosts: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listL4ProxyHosts();
    },
    l4ProxyHost: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      await requireAdmin(context);
      return await getL4ProxyHost(args.id);
    },
    certificates: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return (await listCertificates()).map(projectCertificate);
    },
    certificate: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      await requireAdmin(context);
      const row = await getCertificate(args.id);
      return row ? projectCertificate(row) : null;
    },
    caCertificates: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listCaCertificates();
    },
    clientCertificates: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listIssuedClientCertificates();
    },
    mtlsRoles: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listMtlsRoles();
    },
    accessLists: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listAccessLists();
    },
    accessList: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      await requireAdmin(context);
      return await getAccessList(args.id);
    },
    users: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return (await listUsers()).map(projectUser);
    },
    user: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      await requireAdmin(context);
      const row = await getUserById(args.id);
      return row ? projectUser(row) : null;
    },
    groups: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listGroups();
    },
    group: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      await requireAdmin(context);
      return await getGroup(args.id);
    },
    apiTokens: async (_: unknown, __: unknown, context: GraphQLContext) => {
      // Not admin-gated: every role manages its own tokens, exactly as over REST.
      const viewer = await context.viewer();
      return await listApiTokens(viewer.userId);
    },
    agents: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listAgents();
    },
    oauthProviders: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await listOAuthProviders();
    },
    dnsProviders: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      // No `configured`: that is a settings read per provider, and REST does not answer it either.
      return DNS_PROVIDERS.map((provider) => ({
        id: provider.name,
        name: provider.displayName,
        configured: false,
      }));
    },
    auditLog: async (
      _: unknown,
      args: { limit?: number; offset?: number; search?: string },
      context: GraphQLContext,
    ) => {
      await requireAdmin(context);
      const limit = Math.min(Math.max(args.limit ?? 100, 1), MAX_AUDIT_LOG_LIMIT);
      const offset = Math.max(args.offset ?? 0, 0);
      const [items, total] = await Promise.all([
        listAuditEvents(limit, offset, args.search),
        countAuditEvents(args.search),
      ]);
      return { items, total };
    },
    settings: async (_: unknown, args: { group: string }, context: GraphQLContext) => {
      await requireAdmin(context);
      // The REST groups and redaction: a raw storage key would read any row, secrets included.
      const settings = await readSettingsGroup(args.group);
      if (!settings) throw new NotFoundError("Unknown settings group");
      return settings.value;
    },
    caddyModules: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      return await getCaddyModuleAvailability();
    },
  },

  Mutation: {
    createProxyHost: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      return await createProxyHost(args.input as never, userId);
    },
    updateProxyHost: async (
      _: unknown,
      args: { id: number; input: unknown },
      context: GraphQLContext,
    ) => {
      const { userId } = await requireAdmin(context);
      return await updateProxyHost(args.id, args.input as never, userId);
    },
    deleteProxyHost: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      await deleteProxyHost(args.id, userId);
      return true;
    },
    bulkProxyHosts: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      return (await bulkUpdateProxyHosts(parseProxyHostBulkRequest(args.input), userId)).count;
    },

    createL4ProxyHost: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      return await createL4ProxyHost(args.input as never, userId);
    },
    updateL4ProxyHost: async (
      _: unknown,
      args: { id: number; input: unknown },
      context: GraphQLContext,
    ) => {
      const { userId } = await requireAdmin(context);
      return await updateL4ProxyHost(args.id, args.input as never, userId);
    },
    deleteL4ProxyHost: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      await deleteL4ProxyHost(args.id, userId);
      return true;
    },
    bulkL4ProxyHosts: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      return (await bulkUpdateL4ProxyHosts(parseL4HostBulkRequest(args.input), userId)).count;
    },

    createAccessList: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      return await createAccessList(args.input as never, userId);
    },
    updateAccessList: async (
      _: unknown,
      args: { id: number; input: unknown },
      context: GraphQLContext,
    ) => {
      const { userId } = await requireAdmin(context);
      return await updateAccessList(args.id, args.input as never, userId);
    },
    deleteAccessList: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      await deleteAccessList(args.id, userId);
      return true;
    },

    createGroup: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      return await createGroup(args.input as never, userId);
    },
    updateGroup: async (
      _: unknown,
      args: { id: number; input: unknown },
      context: GraphQLContext,
    ) => {
      const { userId } = await requireAdmin(context);
      return await updateGroup(args.id, args.input as never, userId);
    },
    deleteGroup: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      await deleteGroup(args.id, userId);
      return true;
    },
    addGroupMember: async (
      _: unknown,
      args: { groupId: number; userId: number },
      context: GraphQLContext,
    ) => {
      const { userId } = await requireAdmin(context);
      await addGroupMember(args.groupId, args.userId, userId);
      return true;
    },
    removeGroupMember: async (
      _: unknown,
      args: { groupId: number; userId: number },
      context: GraphQLContext,
    ) => {
      const { userId } = await requireAdmin(context);
      await removeGroupMember(args.groupId, args.userId, userId);
      return true;
    },

    updateUser: async (
      _: unknown,
      args: { id: number; input: { role?: unknown } },
      context: GraphQLContext,
    ) => {
      const { userId } = await requireAdmin(context);
      if (!(await getUserById(args.id))) throw new NotFoundError("User not found");
      if (args.input.role !== undefined && args.input.role !== null) {
        const role = assertUserRole(args.input.role);
        assertNotSelf(userId, args.id, "cannotChangeOwnRole");
        await updateUserRole(args.id, role);
      }
      const row = await getUserById(args.id);
      if (!row) throw new NotFoundError("User not found");
      return projectUser(row);
    },
    deleteUser: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const { userId } = await requireAdmin(context);
      assertNotSelf(userId, args.id, "cannotDeleteOwnAccount");
      if (!(await getUserById(args.id))) throw new NotFoundError("User not found");
      await deleteUser(args.id);
      return true;
    },

    createApiToken: async (
      _: unknown,
      args: { input: { name: string; expiresAt?: string | null } },
      context: GraphQLContext,
    ) => {
      const viewer = await context.viewer();
      // As over REST: a stolen Bearer token must not mint a successor outliving its revocation.
      if (viewer.authMethod !== "session") {
        throw new ApiAuthError("API tokens can only be created from an authenticated session", 403);
      }
      const created = await createApiToken(
        args.input.name,
        viewer.userId,
        args.input.expiresAt ?? undefined,
      );
      // The only time the secret is readable.
      return { token: created.token, secret: created.rawToken };
    },
    deleteApiToken: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const viewer = await context.viewer();
      await deleteApiToken(args.id, viewer.userId);
      return true;
    },

    saveSettings: async (
      _: unknown,
      args: { group: string; input: unknown },
      context: GraphQLContext,
    ) => {
      await requireAdmin(context);
      if (!isSettingsGroup(args.group)) throw new NotFoundError("Unknown settings group");
      // As REST: the group's saver and encryption, the Caddy apply, and rollback on refusal.
      await saveSettingsGroup(args.group, args.input);
      // Redacted - never the credentials the caller just sent.
      return (await readSettingsGroup(args.group))?.value ?? {};
    },

    applyCaddyConfig: async (_: unknown, __: unknown, context: GraphQLContext) => {
      await requireAdmin(context);
      await applyCaddy();
      return true;
    },
  },
};
