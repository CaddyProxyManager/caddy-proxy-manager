/** Audit integrity and the portable config over GraphQL. Admin only, as the dashboard is. */
import { logAuditEvent } from "../audit";
import { verifyAuditChain } from "../audit/chain";
import {
  CONFIG_SECTIONS,
  type ConfigSection,
  MAX_CONFIG_BYTES,
  applyConfigImport,
  exportConfigAudited,
  previewConfigImport,
} from "../config-transfer";
import { ApiAuthError } from "../api/auth";
import { FRESH_SESSION_MAX_AGE_MS, getCurrentSessionInfo, isFreshSession } from "../auth";
import { domainError, domainErrorMessage } from "../errors/domain-error";
import { type GraphQLContext, requireAdmin } from "./context";

/** As the dashboard's routes: a session must be recent. A token is checked by its scope instead. */
async function requireFreshSession(context: GraphQLContext): Promise<void> {
  const viewer = await context.viewer();
  if (viewer.authMethod !== "session") return;
  if (!isFreshSession(await getCurrentSessionInfo(context.request))) {
    throw new ApiAuthError(
      domainErrorMessage("configNeedsFreshSignIn", { minutes: FRESH_SESSION_MAX_AGE_MS / 60_000 }),
      403,
    );
  }
}

/** Base64 runs a third over the bytes; the decoded file is held to the same limit as an upload. */
function decodeFile(file: string): Buffer {
  if (file.length > Math.ceil((MAX_CONFIG_BYTES * 4) / 3) + 4) {
    throw domainError("configFileTooLarge", { max: "50 MiB" }, { status: 400 });
  }
  return Buffer.from(file, "base64");
}

export const auditMutationResolvers = {
  verifyAuditChain: async (_: unknown, __: unknown, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    const verification = await verifyAuditChain();
    await logAuditEvent({
      userId,
      action: "audit_verified",
      entityType: "audit_log",
      summary: "Verified the audit log's hash chain",
      data: {
        ok: verification.ok,
        checked: verification.checked,
        firstBroken: verification.firstBroken,
      },
    });
    return verification;
  },
  exportConfig: async (
    _: unknown,
    args: { passphrase: string; sections?: string[] | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    await requireFreshSession(context);
    const sections = args.sections
      ? args.sections.filter((s): s is ConfigSection =>
          CONFIG_SECTIONS.includes(s as ConfigSection),
        )
      : undefined;
    const file = await exportConfigAudited(args.passphrase, { sections }, userId);
    return file.toString("base64");
  },
  previewConfigImport: async (
    _: unknown,
    args: { file: string; passphrase: string },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    return await previewConfigImport(decodeFile(args.file), args.passphrase);
  },
  applyConfigImport: async (
    _: unknown,
    args: { file: string; passphrase: string },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    await requireFreshSession(context);
    return await applyConfigImport(decodeFile(args.file), args.passphrase, userId);
  },
};
