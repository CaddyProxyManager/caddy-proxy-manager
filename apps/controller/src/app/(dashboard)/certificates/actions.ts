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
import { providerOptionsFromForm } from "@/src/lib/certificates/provider-options";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";
import { getTranslations } from "next-intl/server";

export async function createCertificateAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    const userId = Number(session.user.id);
    const type = String(formData.get("type") ?? "managed") as "managed" | "imported";
    await createCertificate(
      {
        name: String(formData.get("name") ?? "Certificate"),
        type,
        domainNames: parseCsv(formData.get("domain_names")),
        autoRenew: type === "managed" ? formData.get("auto_renew") === "on" : false,
        providerOptions:
          type === "managed" ? providerOptionsFromForm(formData.get("dns_provider")) : null,
        certificatePem: type === "imported" ? String(formData.get("certificate_pem") ?? "") : null,
        privateKeyPem: type === "imported" ? String(formData.get("private_key_pem") ?? "") : null,
      },
      userId,
    );
    revalidatePath("/certificates");
  });
}

export async function updateCertificateAction(
  id: number,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
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
        // The marker says the field was shown, so an empty choice clears the override.
        providerOptions: formData.has("dns_provider_present")
          ? providerOptionsFromForm(formData.get("dns_provider"))
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
  });
}

/** A refusal names the hosts still using it, which only the server can list-format. */
export async function deleteCertificateAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    await deleteCertificate(id, Number(session.user.id));
    revalidatePath("/certificates");
  });
}

/** The picker's file list; keys are named, never read. */
export async function listCertificateFilesAction(
  agentRowId: number,
): Promise<ActionResult<CertificateFileEntry[]>> {
  return runAction(async () => {
    await requireCan("certificates:read");
    return listCertificateFilesOnAgent(agentRowId);
  });
}

export async function createCertificateFromFilesAction(input: {
  name: string;
  agentRowId: number;
  certPath: string;
  keyPath: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    await createCertificateFromAgentFiles(
      {
        name: String(input.name ?? ""),
        agentRowId: Number(input.agentRowId),
        certPath: String(input.certPath ?? ""),
        keyPath: String(input.keyPath ?? ""),
      },
      Number(session.user.id),
    );
    revalidatePath("/certificates");
  });
}

/** A failed read is stored on the row and shown there, so only an unreachable agent errors here. */
export async function rereadCertificateFileAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    try {
      await rereadCertificateFile(id, Number(session.user.id));
    } finally {
      revalidatePath("/certificates");
    }
  });
}

/** The ids the dialog listed; the model recomputes which are still unused. Answers the toast. */
export async function deleteUnusedCertificatesAction(ids: number[]): Promise<ActionResult<string>> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    const { count } = await deleteUnusedCertificates(
      ids.filter((id) => Number.isInteger(id) && id > 0),
      Number(session.user.id),
    );
    revalidatePath("/certificates");
    const t = await getTranslations("certificates");
    return t("deleteUnusedResult", { count });
  });
}
