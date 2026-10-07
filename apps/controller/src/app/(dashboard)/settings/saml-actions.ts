"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
import { createAuditEvent } from "@/src/lib/models/audit";
import { getPublicBaseUrl } from "@/src/lib/http/public-url";
import {
  type SamlProvider,
  type SamlProviderInput,
  createSamlProvider,
  deleteSamlProvider,
  updateSamlProvider,
} from "@/src/lib/models/saml-providers";

async function audit(userId: number, action: string, provider: SamlProvider) {
  const verb = { create: "Created", update: "Updated", delete: "Deleted" }[action];
  await createAuditEvent({
    userId,
    action,
    entityType: "saml_provider",
    entityId: null,
    summary: `${verb} SAML provider ${provider.name}`,
    data: JSON.stringify({ providerId: provider.id }),
  });
}

export async function createSamlProviderAction(input: SamlProviderInput): Promise<SamlProvider> {
  const session = await requireCan("settings:write");
  return withTranslatedErrors(async () => {
    const userId = Number(session.user.id);
    const provider = await createSamlProvider(input, { baseUrl: await getPublicBaseUrl() });
    await audit(userId, "create", provider);
    revalidatePath("/settings");
    return provider;
  });
}

/** A partial input changes only what it names; the list's switch sends `enabled` alone. */
export async function updateSamlProviderAction(
  id: string,
  input: Partial<SamlProviderInput>,
): Promise<SamlProvider> {
  const session = await requireCan("settings:write");
  return withTranslatedErrors(async () => {
    const provider = await updateSamlProvider(id, input);
    await audit(Number(session.user.id), "update", provider);
    revalidatePath("/settings");
    return provider;
  });
}

export async function deleteSamlProviderAction(id: string): Promise<void> {
  const session = await requireCan("settings:write");
  await withTranslatedErrors(async () => {
    const provider = await deleteSamlProvider(id);
    await audit(Number(session.user.id), "delete", provider);
    revalidatePath("/settings");
  });
}
