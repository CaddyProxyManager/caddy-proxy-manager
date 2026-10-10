/**
 * Every resolver calls the model function its `/api/v1/` route calls, so GraphQL and REST cannot
 * disagree - the parity tests assert it. Users (`./identity.ts`) and certificates
 * (`./certificates.ts`) are projected to named fields, so a future secret column cannot leak; the
 * rest is returned whole, extras gathered into `config`. DNS credentials are in ./dns-providers.ts.
 */

import { applyCaddyConfig as applyCaddy } from "../caddy";
import { getApplyFailures } from "../caddy/apply-status";
import { DNS_PROVIDERS } from "../dns/providers";
import { getCaddyModuleAvailability } from "../caddy/image-build";
import { listAccessLists, getAccessList, getAccessListStats } from "../models/access-lists";
import { isConnected } from "../agent/registry";
import { type PairedAgent, listAgents } from "../models/agents";
import { createApiToken, deleteApiToken, listApiTokens } from "../models/api-tokens";
import { parseTokenScope } from "../api-tokens/scope";
import { countAuditEvents, listAuditEvents } from "../models/audit";
import {
  addGroupMember,
  assertMayAddToGroup,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "../models/groups";
import { getL4ProxyHost, listL4ProxyHosts } from "../models/l4-proxy-hosts";
import { listOAuthProviders } from "../models/oauth-providers";
import { getProxyHost, listProxyHosts } from "../models/proxy-hosts";
import { parseL4HostBulkRequest, parseProxyHostBulkRequest } from "../models/bulk-hosts";
import { getProxyHostUpstreamHealth } from "../proxy-hosts/upstream-health";
import { previewL4HostChange, previewProxyHostChange } from "../host-review";
import { deleteUser, getUserById, listUsers, updateUserRole } from "../models/user";
import { can } from "../users/permissions";
import { ApiAuthError, NotFoundError } from "../api/auth";
import { domainErrorMessage } from "../errors/domain-error";
import { isSettingsGroup, readSettingsGroup } from "../settings/api";
import { assertAssignableRole, assertMayManageUser, assertNotSelf } from "../users/admin";
import { apiSubmitter, submitOrApply } from "../approvals";
import { analyticsMutationResolvers, analyticsQueryResolvers } from "./analytics";
import { attentionMutationResolvers, attentionQueryResolvers } from "./attention";
import { securityMutationResolvers, securityQueryResolvers } from "./security";
import { auditMutationResolvers } from "./audit";
import { alertMutationResolvers, alertQueryResolvers } from "./alerts";
import { roleMutationResolvers, roleQueryResolvers } from "./roles";
import {
  certificateMutationResolvers,
  certificateQueryResolvers,
  certificateTypeResolvers,
} from "./certificates";
import { auditStreamMutationResolvers, auditStreamQueryResolvers } from "./audit-stream";
import { scimMutationResolvers, scimQueryResolvers } from "./scim";
import { accessReviewMutationResolvers, accessReviewQueryResolvers } from "./access-reviews";
import { backupMutationResolvers, backupQueryResolvers } from "./backup";
import { approvalMutationResolvers, approvalQueryResolvers } from "./approvals";
import { hostHistoryMutationResolvers, hostHistoryQueryResolvers } from "./host-history";
import { identityMutationResolvers, identityQueryResolvers, projectUser } from "./identity";
import { dnsProviderMutationResolvers } from "./dns-providers";
import type { GraphQLContext } from "./context";
import { DateTimeScalar, JSONScalar } from "./scalars";

/** The rest becomes `config`. */
const PROXY_HOST_SCALAR_FIELDS = new Set([
  "id",
  "name",
  "description",
  "tags",
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
  "tags",
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

export const resolvers = {
  JSON: JSONScalar,
  DateTime: DateTimeScalar,

  ProxyHost: {
    config: (host: Record<string, unknown>) => remainder(host, PROXY_HOST_SCALAR_FIELDS),
  },
  L4ProxyHost: {
    config: (host: Record<string, unknown>) => remainder(host, L4_SCALAR_FIELDS),
  },
  AccessList: {
    rules: (list: { ipRules: unknown[] }) => list.ipRules,
  },
  ...certificateTypeResolvers,
  Agent: {
    // Not a column: whether this process holds the agent's stream (lib/agent/registry.ts).
    connected: (agent: PairedAgent) => isConnected(agent.agentId),
    lastApplyFailure: async (agent: PairedAgent, _: unknown, context: GraphQLContext) => {
      const failures = await (context.applyFailures?.() ?? getApplyFailures());
      const failure = failures[agent.agentId];
      return failure ? { at: failure.at, error: failure.error } : null;
    },
  },

  Query: {
    proxyHosts: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      return await listProxyHosts();
    },
    proxyHost: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
      return await getProxyHost(args.id);
    },
    proxyHostUpstreamHealth: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
      return await getProxyHostUpstreamHealth(args.id);
    },
    l4ProxyHosts: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      return await listL4ProxyHosts();
    },
    l4ProxyHost: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
      return await getL4ProxyHost(args.id);
    },
    accessLists: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      return await listAccessLists();
    },
    accessList: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
      return await getAccessList(args.id);
    },
    accessListStats: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
      if (!(await getAccessList(args.id))) throw new NotFoundError("Access list not found");
      const stats = await getAccessListStats(args.id);
      return {
        hosts: stats.hosts,
        stopped: stats.traffic?.stopped ?? null,
        failedSignIns: stats.traffic?.failedSignIns ?? null,
      };
    },
    users: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      return (await listUsers()).map(projectUser);
    },
    user: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
      const row = await getUserById(args.id);
      return row ? projectUser(row) : null;
    },
    groups: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      return await listGroups();
    },
    group: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
      return await getGroup(args.id);
    },
    apiTokens: async (_: unknown, __: unknown, context: GraphQLContext) => {
      // Not admin-gated: every role manages its own tokens, exactly as over REST.
      const viewer = await context.viewer();
      return await listApiTokens(viewer.userId);
    },
    agents: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      return await listAgents();
    },
    oauthProviders: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      return await listOAuthProviders();
    },
    dnsProviders: async (_: unknown, __: unknown, _context: GraphQLContext) => {
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
      _context: GraphQLContext,
    ) => {
      const limit = Math.min(Math.max(args.limit ?? 100, 1), MAX_AUDIT_LOG_LIMIT);
      const offset = Math.max(args.offset ?? 0, 0);
      const [items, total] = await Promise.all([
        listAuditEvents(limit, offset, args.search),
        countAuditEvents(args.search),
      ]);
      return { items, total };
    },
    settings: async (_: unknown, args: { group: string }, _context: GraphQLContext) => {
      // The REST groups and redaction: a raw storage key would read any row, secrets included.
      const settings = await readSettingsGroup(args.group);
      if (!settings) throw new NotFoundError("Unknown settings group");
      return settings.value;
    },
    caddyModules: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      return await getCaddyModuleAvailability();
    },
    signInOverview: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      const { getSignInOverview } = await import("../users/sign-in-overview");
      return await getSignInOverview();
    },
    ...analyticsQueryResolvers,
    ...attentionQueryResolvers,
    ...securityQueryResolvers,
    ...backupQueryResolvers,
    ...alertQueryResolvers,
    ...roleQueryResolvers,
    ...certificateQueryResolvers,
    ...auditStreamQueryResolvers,
    ...scimQueryResolvers,
    ...accessReviewQueryResolvers,
    ...hostHistoryQueryResolvers,
    ...approvalQueryResolvers,
    ...identityQueryResolvers,
  },

  Mutation: {
    createProxyHost: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "proxyHostCreate",
        payload: { input: args.input as never },
      });
    },
    updateProxyHost: async (
      _: unknown,
      args: { id: number; input: unknown },
      context: GraphQLContext,
    ) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "proxyHostUpdate",
        payload: { id: args.id, input: args.input as never },
      });
    },
    deleteProxyHost: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const submitter = apiSubmitter(await context.viewer());
      await submitOrApply(submitter, { kind: "proxyHostDelete", payload: { id: args.id } });
      return true;
    },
    previewProxyHost: async (
      _: unknown,
      args: { id?: number | null; input: unknown; revert?: string[] | null },
      context: GraphQLContext,
    ) => {
      const { userId } = await context.viewer();
      return await previewProxyHostChange(
        { id: args.id ?? null, input: args.input as never, reverted: args.revert ?? [] },
        userId,
      );
    },
    bulkProxyHosts: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "proxyHostBulk",
        payload: parseProxyHostBulkRequest(args.input),
      });
    },

    createL4ProxyHost: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "l4HostCreate",
        payload: { input: args.input as never },
      });
    },
    updateL4ProxyHost: async (
      _: unknown,
      args: { id: number; input: unknown },
      context: GraphQLContext,
    ) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "l4HostUpdate",
        payload: { id: args.id, input: args.input as never },
      });
    },
    deleteL4ProxyHost: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const submitter = apiSubmitter(await context.viewer());
      await submitOrApply(submitter, { kind: "l4HostDelete", payload: { id: args.id } });
      return true;
    },
    previewL4ProxyHost: async (
      _: unknown,
      args: { id?: number | null; input: unknown; revert?: string[] | null },
      context: GraphQLContext,
    ) => {
      const { userId } = await context.viewer();
      return await previewL4HostChange(
        { id: args.id ?? null, input: args.input as never, reverted: args.revert ?? [] },
        userId,
      );
    },
    bulkL4ProxyHosts: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "l4HostBulk",
        payload: parseL4HostBulkRequest(args.input),
      });
    },

    createAccessList: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "accessListCreate",
        payload: { input: args.input as never },
      });
    },
    updateAccessList: async (
      _: unknown,
      args: { id: number; input: unknown },
      context: GraphQLContext,
    ) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "accessListUpdate",
        payload: { id: args.id, input: args.input as never },
      });
    },
    deleteAccessList: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const submitter = apiSubmitter(await context.viewer());
      await submitOrApply(submitter, { kind: "accessListDelete", payload: { id: args.id } });
      return true;
    },
    setAccessListRules: async (
      _: unknown,
      args: { id: number; rules: unknown },
      context: GraphQLContext,
    ) => {
      const submitter = apiSubmitter(await context.viewer());
      return await submitOrApply(submitter, {
        kind: "accessListRules",
        payload: { id: args.id, rules: args.rules },
      });
    },

    createGroup: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
      const { userId } = await context.viewer();
      return await createGroup(args.input as never, userId);
    },
    updateGroup: async (
      _: unknown,
      args: { id: number; input: unknown },
      context: GraphQLContext,
    ) => {
      const { userId } = await context.viewer();
      return await updateGroup(args.id, args.input as never, userId);
    },
    deleteGroup: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const { userId } = await context.viewer();
      await deleteGroup(args.id, userId);
      return true;
    },
    addGroupMember: async (
      _: unknown,
      args: { groupId: number; userId: number },
      context: GraphQLContext,
    ) => {
      const { userId } = await context.viewer();
      await assertMayAddToGroup((await context.access()).capabilities, args.groupId);
      await addGroupMember(args.groupId, args.userId, userId);
      return true;
    },
    removeGroupMember: async (
      _: unknown,
      args: { groupId: number; userId: number },
      context: GraphQLContext,
    ) => {
      const { userId } = await context.viewer();
      await removeGroupMember(args.groupId, args.userId, userId);
      return true;
    },

    updateUser: async (
      _: unknown,
      args: { id: number; input: { role?: unknown } },
      context: GraphQLContext,
    ) => {
      const { userId } = await context.viewer();
      const { capabilities } = await context.access();
      if (!(await assertMayManageUser(capabilities, args.id))) {
        throw new NotFoundError("User not found");
      }
      if (args.input.role !== undefined && args.input.role !== null) {
        assertNotSelf(userId, args.id, "cannotChangeOwnRole");
        const role = await assertAssignableRole(capabilities, args.input.role);
        await updateUserRole(args.id, role);
      }
      const row = await getUserById(args.id);
      if (!row) throw new NotFoundError("User not found");
      return projectUser(row);
    },
    deleteUser: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const { userId } = await context.viewer();
      assertNotSelf(userId, args.id, "cannotDeleteOwnAccount");
      const { capabilities } = await context.access();
      if (!(await assertMayManageUser(capabilities, args.id))) {
        throw new NotFoundError("User not found");
      }
      await deleteUser(args.id);
      return true;
    },

    createApiToken: async (
      _: unknown,
      args: {
        input: {
          name: string;
          expiresAt?: string | null;
          scope?: unknown;
          permissions?: unknown;
        };
      },
      context: GraphQLContext,
    ) => {
      const viewer = await context.viewer();
      // As over REST: a stolen Bearer token must not mint a successor outliving its revocation.
      if (viewer.authMethod !== "session") {
        throw new ApiAuthError("API tokens can only be created from an authenticated session", 403);
      }
      // A token carries the account's real role, not the one being previewed.
      if (viewer.viewAsGroupIds !== undefined) {
        throw new ApiAuthError(domainErrorMessage("viewAsForbidden"), 403);
      }
      const created = await createApiToken(
        args.input.name,
        viewer.userId,
        args.input.expiresAt ?? undefined,
        parseTokenScope(args.input.scope, args.input.permissions),
      );
      // The only time the secret is readable.
      return { token: created.token, secret: created.rawToken };
    },
    deleteApiToken: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
      const viewer = await context.viewer();
      // As DELETE /api/v1/tokens/{id}: a holder of tokens:write may revoke anyone's.
      await deleteApiToken(args.id, viewer.userId, can(await context.access(), "tokens:write"));
      return true;
    },

    saveSettings: async (
      _: unknown,
      args: { group: string; input: unknown },
      context: GraphQLContext,
    ) => {
      if (!isSettingsGroup(args.group)) throw new NotFoundError("Unknown settings group");
      // As REST: the group's saver and encryption, the Caddy apply, and rollback on refusal.
      await submitOrApply(apiSubmitter(await context.viewer()), {
        kind: "settingsGroup",
        payload: { group: args.group, input: args.input },
      });
      // Redacted - never the credentials the caller just sent.
      return (await readSettingsGroup(args.group))?.value ?? {};
    },

    applyCaddyConfig: async (_: unknown, __: unknown, _context: GraphQLContext) => {
      await applyCaddy();
      return true;
    },

    ...analyticsMutationResolvers,
    ...attentionMutationResolvers,
    ...securityMutationResolvers,
    ...auditMutationResolvers,
    ...backupMutationResolvers,
    ...alertMutationResolvers,
    ...roleMutationResolvers,
    ...certificateMutationResolvers,
    ...auditStreamMutationResolvers,
    ...scimMutationResolvers,
    ...accessReviewMutationResolvers,
    ...hostHistoryMutationResolvers,
    ...approvalMutationResolvers,
    ...identityMutationResolvers,
    ...dnsProviderMutationResolvers,
  },
};
