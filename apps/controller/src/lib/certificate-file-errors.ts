/** Client-safe: the Imported tab words a stored `sourceError` with the same catalog entries. */
import type { CertificateFileError } from "@cpm/shared";
import type { DomainErrorCode } from "./domain-error";

export const CERTIFICATE_FILE_ERROR_MESSAGES: Record<CertificateFileError, DomainErrorCode> = {
  "not-configured": "certificateFileNotConfigured",
  unavailable: "certificateFileUnavailable",
  "invalid-path": "certificateFileInvalidPath",
  "not-found": "certificateFileNotFound",
  "outside-directory": "certificateFileOutsideDirectory",
  "too-large": "certificateFileTooLarge",
  "not-a-certificate": "certificateFileNotACertificate",
  "not-a-key": "certificateFileNotAKey",
  "key-mismatch": "certificateFileKeyMismatch",
  "no-names": "certificateFileNoNames",
};

/** An unknown code (a newer agent's) still gets a sentence. */
export function certificateFileErrorMessage(code: string): DomainErrorCode {
  return (
    CERTIFICATE_FILE_ERROR_MESSAGES[code as CertificateFileError] ?? "certificateFileUnavailable"
  );
}
