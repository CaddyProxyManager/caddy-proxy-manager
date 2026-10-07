"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import {
  createSink,
  deleteSink,
  listSinks,
  type SinkInput,
  type SinkView,
  testSink,
  updateSink,
} from "@/src/lib/audit-stream";
import { storedErrorMessage } from "@/src/lib/errors/action-error";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";

const PAGE = "/settings/audit-streaming";

async function adminId(): Promise<number> {
  return Number((await requireCan("audit:write")).user.id);
}

/** The last error rendered here, in the reader's language: the catalog stays on the server. */
export async function loadSinksAction(): Promise<SinkView[]> {
  await requireCan("audit:read");
  const [sinks, t] = await Promise.all([listSinks(), getTranslations()]);
  return sinks.map((sink) => ({
    ...sink,
    lastError: sink.lastError && storedErrorMessage(t, sink.lastError, sink.lastErrorCode),
  }));
}

export async function saveSinkAction(id: number | null, input: SinkInput): Promise<void> {
  const userId = await adminId();
  await withTranslatedErrors(async () => {
    if (id === null) await createSink(input, userId);
    else await updateSink(id, input, userId);
    revalidatePath(PAGE);
  });
}

export async function deleteSinkAction(id: number): Promise<void> {
  const userId = await adminId();
  await withTranslatedErrors(async () => {
    await deleteSink(id, userId);
    revalidatePath(PAGE);
  });
}

export type SinkTestOutcome =
  | { ok: true; encodingRefused: boolean }
  | { ok: false; message: string };

/** A saved sink as stored, or with `input` the form as typed: its blank secrets are the stored ones. */
export async function testSinkAction(
  id: number | null,
  input: SinkInput | null,
): Promise<SinkTestOutcome> {
  await requireCan("audit:write");
  try {
    const result = await withTranslatedErrors(() => testSink(id, input));
    return { ok: true, encodingRefused: result.encodingRefused };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
