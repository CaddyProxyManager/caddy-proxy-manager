/**
 * Thrown where a covered write was turned into a change request instead of applied. Every entry
 * point already turns a thrown error into its answer, so one class covers them: REST answers 202,
 * GraphQL 202 with the id in the error's extensions, and an action reports it as done.
 */
import { DomainError, domainErrorMessage } from "../errors/domain-error";

export class ChangeSubmitted extends DomainError {
  constructor(readonly requestId: number) {
    super(
      "changeSubmittedForApproval",
      { id: requestId },
      domainErrorMessage("changeSubmittedForApproval", { id: requestId }),
    );
    this.name = "ChangeSubmitted";
  }
}

/** What an action that returns data hands back instead, for the page to say so. */
export type SubmittedForApproval = { submittedForApproval: number; message: string };

export function isSubmittedForApproval(value: unknown): value is SubmittedForApproval {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as SubmittedForApproval).submittedForApproval === "number"
  );
}

/** console.error for a failed write; one that went for approval did not fail. */
export function logWriteFailure(error: unknown, message: string, ...context: unknown[]): void {
  if (error instanceof ChangeSubmitted) return;
  console.error(message, ...context, error);
}
