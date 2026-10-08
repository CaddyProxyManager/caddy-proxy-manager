"use server";

import { requireCan, requireCanAccess } from "@/src/lib/users/permissions";
import { assertMayConfigureSignIn } from "@/src/lib/roles/sign-in-sources";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";
import { createAuditEvent } from "@/src/lib/models/audit";
import {
  type LdapDirectoryInput,
  type LdapDirectoryView,
  createLdapDirectory,
  deleteLdapDirectory,
  getLdapDirectory,
  previewLdapDirectory,
  setLdapDirectoryEnabled,
  toLdapDirectoryView,
  updateLdapDirectory,
} from "@/src/lib/models/ldap-directories";
import { testLdapConnection } from "@/src/lib/ldap/client";
import { mapGroupsToRole, toGroupMappingConfig } from "@/src/lib/auth/oidc/groups";

async function audit(userId: number, action: string, summary: string, directoryId: string) {
  await createAuditEvent({
    userId,
    action,
    entityType: "ldap_directory",
    entityId: null,
    summary,
    data: JSON.stringify({ directoryId }),
  });
}

export async function createLdapDirectoryAction(
  input: LdapDirectoryInput,
): Promise<ActionResult<LdapDirectoryView>> {
  return runAction(async () => {
    const { session, access } = await requireCanAccess("settings:write");
    await assertMayConfigureSignIn(access.capabilities, null, input);
    const directory = await createLdapDirectory(input);
    await audit(
      Number(session.user.id),
      "create",
      `Created directory ${directory.name}`,
      directory.id,
    );
    revalidatePath("/settings");
    return toLdapDirectoryView(directory);
  });
}

export async function updateLdapDirectoryAction(
  id: string,
  input: LdapDirectoryInput,
): Promise<ActionResult<LdapDirectoryView>> {
  return runAction(async () => {
    const { session, access } = await requireCanAccess("settings:write");
    await assertMayConfigureSignIn(access.capabilities, await getLdapDirectory(id), input);
    const directory = await updateLdapDirectory(id, input);
    await audit(Number(session.user.id), "update", `Updated directory ${directory.name}`, id);
    revalidatePath("/settings");
    return toLdapDirectoryView(directory);
  });
}

export async function setLdapDirectoryEnabledAction(
  id: string,
  enabled: boolean,
): Promise<ActionResult<LdapDirectoryView>> {
  return runAction(async () => {
    const session = await requireCan("settings:write");
    const directory = await setLdapDirectoryEnabled(id, enabled);
    await audit(Number(session.user.id), "update", `Updated directory ${directory.name}`, id);
    revalidatePath("/settings");
    return toLdapDirectoryView(directory);
  });
}

export async function deleteLdapDirectoryAction(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireCan("settings:write");
    const directory = await deleteLdapDirectory(id);
    await audit(Number(session.user.id), "delete", `Deleted directory ${directory.name}`, id);
    revalidatePath("/settings");
  });
}

/** Catalog keys are camelCase; the reasons are the client's own spelling. */
const SIGN_IN_FAILURE_KEYS = {
  "invalid-input": "invalidInput",
  "invalid-credentials": "invalidCredentials",
  "not-found": "notFound",
  ambiguous: "ambiguous",
  "refused-username": "refusedUsername",
  "other-entry": "otherEntry",
  unavailable: "unavailable",
} as const;

export type LdapTestView = {
  ok: boolean;
  message: string;
  /** The server's or TLS layer's words, untranslated: they are what to search for. */
  detail: string | null;
  identity: {
    dn: string;
    email: string | null;
    name: string | null;
    groups: string[];
    role: string | null;
  } | null;
};

/**
 * Tests the form as it stands, unsaved. Admin-only, since it dials whatever address it is given;
 * the address is limited to ldap:// and ldaps://, and every step has a timeout.
 */
export async function testLdapDirectoryAction(
  input: LdapDirectoryInput,
  existingId: string | null,
  probe: { username: string; password: string } | null,
): Promise<ActionResult<LdapTestView>> {
  return runAction(async () => {
    await requireCan("settings:write");
    const t = await getTranslations("settings.ldap.test");
    const directory = await previewLdapDirectory(input, existingId);
    const result = await testLdapConnection(
      directory,
      probe?.username.trim() && probe.password
        ? { ...probe, username: probe.username.trim() }
        : undefined,
    );
    if (!result.ok) {
      const message =
        result.stage === "sign-in"
          ? t(`signIn.${SIGN_IN_FAILURE_KEYS[result.reason ?? "unavailable"]}`)
          : t(`stage.${result.stage}`);
      return { ok: false, message, detail: result.detail ?? null, identity: null };
    }
    if (!result.identity) {
      // With no service account nothing can be read until a user binds: say how little was proven.
      const message = directory.config.userDnTemplate ? t("connectedUserBind") : t("connected");
      return { ok: true, message, detail: null, identity: null };
    }
    const mapping = toGroupMappingConfig(directory);
    return {
      ok: true,
      message: t("signedIn"),
      detail: null,
      identity: {
        dn: result.identity.dn,
        email: result.identity.email,
        name: result.identity.name,
        groups: result.identity.groups,
        role: mapping.roleMappingEnabled ? mapGroupsToRole(result.identity.groups, mapping) : null,
      },
    };
  });
}
