/**
 * The certificate family over GraphQL: certificates, CAs, the client certificates they issued,
 * mTLS roles and per-path mTLS access rules, through the model calls their `/api/v1/` routes make.
 * A certificate row carries its private key, so every answer goes through `projectCertificate`.
 */

import { NotFoundError } from "../api/auth";
import { ApiValidationError } from "../api/errors";
import { apiSubmitter, submitOrApply } from "../approvals";
import {
  type CaCertificateInput,
  createCaCertificate,
  deleteCaCertificate,
  listCaCertificates,
} from "../models/ca-certificates";
import {
  createCertificateFromAgentFiles,
  rereadCertificateFile,
} from "../models/certificate-files";
import {
  type Certificate,
  type CertificateInput,
  createCertificate,
  deleteCertificate,
  getCertificate,
  listCertificates,
  updateCertificate,
} from "../models/certificates";
import {
  type IssuedClientCertificateInput,
  createIssuedClientCertificate,
  listIssuedClientCertificates,
  revokeIssuedClientCertificate,
} from "../models/issued-client-certificates";
import { listMtlsAccessRules } from "../models/mtls-access-rules";
import {
  type MtlsRoleInput,
  assignRoleToCertificate,
  createMtlsRole,
  deleteMtlsRole,
  getCertificateRoles,
  getMtlsRole,
  listMtlsRoles,
  removeRoleFromCertificate,
  updateMtlsRole,
} from "../models/mtls-roles";
import { getProxyHost } from "../models/proxy-hosts";
import { normalizeCertificateProviderOptions } from "../certificates/provider-options";
import type { GraphQLContext } from "./context";

/** The row carries a private key. */
export function projectCertificate(row: Certificate) {
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
    // The provider name alone: a row written before the shape was fixed may carry more.
    providerOptions: normalizeCertificateProviderOptions(row.providerOptions),
  };
}

/** The 400 the REST route answers before the model sees the body. */
function requireNonEmptyString(input: Record<string, unknown>, field: string): void {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiValidationError(`${field} is required`);
  }
}

async function requireMtlsRole(id: number) {
  const role = await getMtlsRole(id);
  if (!role) throw new NotFoundError("mTLS role not found");
  return role;
}

export const certificateQueryResolvers = {
  certificates: async () => (await listCertificates()).map(projectCertificate),
  certificate: async (_: unknown, args: { id: number }) => {
    const row = await getCertificate(args.id);
    return row ? projectCertificate(row) : null;
  },
  caCertificates: async () => await listCaCertificates(),
  clientCertificates: async () => await listIssuedClientCertificates(),
  clientCertificateRoles: async (_: unknown, args: { id: number }) =>
    await getCertificateRoles(args.id),
  mtlsRoles: async () => await listMtlsRoles(),
  mtlsAccessRules: async (_: unknown, args: { proxyHostId: number }) => {
    if (!(await getProxyHost(args.proxyHostId))) throw new NotFoundError("Proxy host not found");
    return await listMtlsAccessRules(args.proxyHostId);
  },
};

export const certificateTypeResolvers = {
  MtlsRole: {
    // The list answers a count only; a role read alone carries its ids.
    certificateIds: async (role: { id: number; certificateIds?: number[] }) =>
      role.certificateIds ?? (await requireMtlsRole(role.id)).certificateIds,
  },
};

export const certificateMutationResolvers = {
  createCertificate: async (
    _: unknown,
    args: { input: Record<string, unknown> },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    const body = args.input;
    // Read from the agent before anything is stored; see models/certificate-files.ts.
    const cert =
      body.source === "agent-file"
        ? await createCertificateFromAgentFiles(
            {
              name: String(body.name ?? ""),
              agentRowId: Number(body.sourceAgentId),
              certPath: String(body.sourceCertPath ?? ""),
              keyPath: String(body.sourceKeyPath ?? ""),
            },
            userId,
          )
        : await createCertificate(body as CertificateInput, userId);
    return projectCertificate(cert);
  },
  updateCertificate: async (
    _: unknown,
    args: { id: number; input: Partial<CertificateInput> },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return projectCertificate(await updateCertificate(args.id, args.input, userId));
  },
  deleteCertificate: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    await deleteCertificate(args.id, userId);
    return true;
  },
  rereadCertificate: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    return projectCertificate(await rereadCertificateFile(args.id, userId));
  },

  createCaCertificate: async (
    _: unknown,
    args: { input: CaCertificateInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return await createCaCertificate(args.input, userId);
  },
  deleteCaCertificate: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    await deleteCaCertificate(args.id, userId);
    return true;
  },

  issueClientCertificate: async (
    _: unknown,
    args: { input: IssuedClientCertificateInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return await createIssuedClientCertificate(args.input, userId);
  },
  revokeClientCertificate: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    return await revokeIssuedClientCertificate(args.id, userId);
  },

  createMtlsRole: async (
    _: unknown,
    args: { input: Record<string, unknown> },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    requireNonEmptyString(args.input, "name");
    return await createMtlsRole(args.input as MtlsRoleInput, userId);
  },
  updateMtlsRole: async (
    _: unknown,
    args: { id: number; input: Partial<MtlsRoleInput> },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return await updateMtlsRole(args.id, args.input, userId);
  },
  deleteMtlsRole: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    await deleteMtlsRole(args.id, userId);
    return true;
  },
  addMtlsRoleCertificate: async (
    _: unknown,
    args: { roleId: number; certificateId: number },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    await assignRoleToCertificate(args.roleId, args.certificateId, userId);
    return await requireMtlsRole(args.roleId);
  },
  removeMtlsRoleCertificate: async (
    _: unknown,
    args: { roleId: number; certificateId: number },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    await removeRoleFromCertificate(args.roleId, args.certificateId, userId);
    return true;
  },

  createMtlsAccessRule: async (
    _: unknown,
    args: { proxyHostId: number; input: Record<string, unknown> },
    context: GraphQLContext,
  ) => {
    if (!(await getProxyHost(args.proxyHostId))) throw new NotFoundError("Proxy host not found");
    requireNonEmptyString(args.input, "pathPattern");
    const submitter = apiSubmitter(await context.viewer());
    return await submitOrApply(submitter, {
      kind: "mtlsRuleCreate",
      payload: { input: { ...args.input, proxyHostId: args.proxyHostId } as never },
    });
  },
  updateMtlsAccessRule: async (
    _: unknown,
    args: { id: number; input: unknown },
    context: GraphQLContext,
  ) => {
    const submitter = apiSubmitter(await context.viewer());
    return await submitOrApply(submitter, {
      kind: "mtlsRuleUpdate",
      payload: { id: args.id, input: args.input as never },
    });
  },
  deleteMtlsAccessRule: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const submitter = apiSubmitter(await context.viewer());
    await submitOrApply(submitter, { kind: "mtlsRuleDelete", payload: { id: args.id } });
    return true;
  },
};
