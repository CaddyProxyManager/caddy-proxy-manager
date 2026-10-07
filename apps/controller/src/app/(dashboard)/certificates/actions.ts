"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import {
  createCertificate,
  deleteCertificate,
  deleteUnusedCertificates,
  updateCertificate,
} from "@/src/lib/models/certificates";
import {
  createCertificateFromAgentFiles,
  listCertificateFilesOnAgent,
  rereadCertificateFile,
} from "@/src/lib/models/certificate-files";
import type { CertificateFileEntry } from "@cpm/shared";
import { parseCsv } from "@/src/lib/forms/form-parse";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
import { getTranslations } from "next-intl/server";

export async function createCertificateAction(formData: FormData) {
  const session = await requireCan("certificates:write");
  const userId = Number(session.user.id);
  const type = String(formData.get("type") ?? "managed") as "managed" | "imported";
  await createCertificate(
    {
      name: String(formData.get("name") ?? "Certificate"),
      type,
      domainNames: parseCsv(formData.get("domain_names")),
      autoRenew: type === "managed" ? formData.get("auto_renew") === "on" : false,
      certificatePem: type === "imported" ? String(formData.get("certificate_pem") ?? "") : null,
      privateKeyPem: type === "imported" ? String(formData.get("private_key_pem") ?? "") : null,
    },
    userId,
  );
  revalidatePath("/certificates");
}

export async function updateCertificateAction(id: number, formData: FormData) {
  const session = await requireCan("certificates:write");
  const userId = Number(session.user.id);
  const type = formData.get("type")
    ? (String(formData.get("type")) as "managed" | "imported")
    : undefined;
  await updateCertificate(
    id,
    {
      name: formData.get("name") ? String(formData.get("name")) : undefined,
      type,
      domainNames: formData.get("domain_names")
        ? parseCsv(formData.get("domain_names"))
        : undefined,
      autoRenew: formData.has("auto_renew_present")
        ? formData.get("auto_renew") === "on"
        : undefined,
      certificatePem: formData.get("certificate_pem")
        ? String(formData.get("certificate_pem"))
        : undefined,
      privateKeyPem: formData.get("private_key_pem")
        ? String(formData.get("private_key_pem"))
        : undefined,
    },
    userId,
  );
  revalidatePath("/certificates");
}

export async function deleteCertificateAction(
  id: number,
): Promise<{ success: boolean; error?: string }> {
  const session = await requireCan("certificates:write");
  const userId = Number(session.user.id);
  try {
    // A refusal names the hosts still using it, which only the server can list-format.
    await withTranslatedErrors(() => deleteCertificate(id, userId));
    revalidatePath("/certificates");
    return { success: true };
  } catch (e) {
    const t = await getTranslations("certificates");
    return { success: false, error: e instanceof Error ? e.message : t("deleteFailed") };
  }
}

type Outcome<T = void> = { success: true; value?: T } | { success: false; error: string };

async function translated<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { success: true, value: await withTranslatedErrors(run) };
  } catch (e) {
    const t = await getTranslations("certificates");
    return { success: false, error: e instanceof Error ? e.message : t("certificateFilesFailed") };
  }
}

/** The picker's file list; keys are named, never read. */
export async function listCertificateFilesAction(
  agentRowId: number,
): Promise<Outcome<CertificateFileEntry[]>> {
  await requireCan("certificates:read");
  return translated(() => listCertificateFilesOnAgent(agentRowId));
}

export async function createCertificateFromFilesAction(input: {
  name: string;
  agentRowId: number;
  certPath: string;
  keyPath: string;
}): Promise<Outcome> {
  const session = await requireCan("certificates:write");
  const outcome = await translated(async () => {
    await createCertificateFromAgentFiles(
      {
        name: String(input.name ?? ""),
        agentRowId: Number(input.agentRowId),
        certPath: String(input.certPath ?? ""),
        keyPath: String(input.keyPath ?? ""),
      },
      Number(session.user.id),
    );
  });
  if (outcome.success) revalidatePath("/certificates");
  return outcome;
}

/** A failed read is stored on the row and shown there, so only an unreachable agent errors here. */
export async function rereadCertificateFileAction(id: number): Promise<Outcome> {
  const session = await requireCan("certificates:write");
  const outcome = await translated(async () => {
    await rereadCertificateFile(id, Number(session.user.id));
  });
  revalidatePath("/certificates");
  return outcome;
}

/** The ids the dialog listed; the model recomputes which are still unused. */
export async function deleteUnusedCertificatesAction(
  ids: number[],
): Promise<{ success: boolean; message?: string; error?: string }> {
  const session = await requireCan("certificates:write");
  const userId = Number(session.user.id);
  const t = await getTranslations("certificates");
  try {
    const { count } = await withTranslatedErrors(() =>
      deleteUnusedCertificates(
        ids.filter((id) => Number.isInteger(id) && id > 0),
        userId,
      ),
    );
    revalidatePath("/certificates");
    return { success: true, message: t("deleteUnusedResult", { count }) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : t("deleteFailed") };
  }
}
