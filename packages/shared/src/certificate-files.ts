/**
 * Certificates an agent reads from files on its host. The directory is the operator's
 * (`CERT_FILES_HOST_DIR` on the agent); the controller only names paths inside it, so both sides
 * check them with this one rule and the agent re-checks what the controller sends.
 */

/** A PEM chain or key is kilobytes; anything past this is not one. */
export const CERTIFICATE_FILE_MAX_BYTES = 1024 * 1024;

/** Per agent, which also bounds a desired-state frame and a result batch. */
export const CERTIFICATE_FILES_MAX = 500;

/** No leading dot or dash, so no `.`, `..`, hidden files or anything a CLI reads as a flag. */
const SEGMENT = /^[A-Za-z0-9_@+=,*~][A-Za-z0-9._@+=,*~-]{0,254}$/;
const MAX_SEGMENTS = 16;
const MAX_PATH = 1024;

/** Relative, `/`-separated, no traversal, nothing a shell or `docker` would read specially. */
export function isValidCertificateFilePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH) return false;
  const segments = path.split("/");
  return segments.length <= MAX_SEGMENTS && segments.every((segment) => SEGMENT.test(segment));
}
