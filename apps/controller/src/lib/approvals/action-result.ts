/** For actions that return what they wrote: a write held for approval returns that instead. */
import { getTranslations } from "next-intl/server";
import { ChangeSubmitted, type SubmittedForApproval } from "./submitted";

export async function orSubmitted<T>(run: () => Promise<T>): Promise<T | SubmittedForApproval> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ChangeSubmitted)) throw error;
    const t = await getTranslations("errors");
    return {
      submittedForApproval: error.requestId,
      message: t("changeSubmittedForApproval", { id: error.requestId }),
    };
  }
}
