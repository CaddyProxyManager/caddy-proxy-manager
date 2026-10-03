/**
 * Certificates from files on this host (CERT_FILES_HOST_DIR), read and sent to the controller as
 * PEM. Caddy is never pointed at the files: it caches `load_files`, and a missing file fails the
 * whole config load. Reads run in a container that mounts only that directory; see
 * `DockerHost.runInCertificateDirectory`.
 */
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import {
  CERTIFICATE_FILE_MAX_BYTES,
  type CertificateFileEntry,
  type CertificateFileError,
  type CertificateFileResult,
  type CertificateFileSource,
  type CertificateFilesAck,
  isValidCertificateFilePath,
} from "@cpm/shared";
import type { AgentConfig } from "./config";
import type { DockerHost } from "./docker";

const SEPARATOR = "@@cpm-certfile@@";
/** Each also the controller's poll: Caddy reloads nothing by itself, and renewals are days early. */
export const CERTIFICATE_FILES_POLL_MS = 6 * 60 * 60_000;
/** Under the controller's 8 MiB request cap, with room for JSON escaping of the PEM. */
const POST_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Fixed scripts: paths reach them only as positional arguments. `realpath` keeps a symlink inside
 * the mount, though outside it there is only this throwaway container's own filesystem anyway.
 */
const LIST_SCRIPT = `cd /certs || exit 3
find -L . -maxdepth 8 -type f -size -1025k 2>/dev/null | head -n 5000 | while IFS= read -r f; do
  r=$(realpath "$f" 2>/dev/null) || continue
  case "$r" in /certs/*) ;; *) continue ;; esac
  if grep -q -e "-----BEGIN CERTIFICATE-----" "$r" 2>/dev/null; then
    echo "${SEPARATOR} certificate \${f#./}"; head -c ${CERTIFICATE_FILE_MAX_BYTES} "$r"; echo
  elif grep -q -e "PRIVATE KEY-----" "$r" 2>/dev/null; then
    echo "${SEPARATOR} key \${f#./}"
  fi
done`;

const READ_SCRIPT = `cd /certs || exit 3
i=0
for f in "$@"; do
  i=$((i+1))
  r=$(realpath "$f" 2>/dev/null) || { echo "${SEPARATOR} $i not-found"; continue; }
  case "$r" in /certs/*) ;; *) echo "${SEPARATOR} $i outside-directory"; continue ;; esac
  [ -f "$r" ] || { echo "${SEPARATOR} $i not-found"; continue; }
  echo "${SEPARATOR} $i ok"; head -c ${CERTIFICATE_FILE_MAX_BYTES + 1} "$r"; echo
done`;

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;
const PEM_KEY = /-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----[A-Za-z0-9+/=\s]+?-----END \1-----/;

/** DNS and IP SANs, the names a TLS client can ask for. */
export function certificateNames(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:") || entry.startsWith("IP Address:"))
    .map((entry) => entry.replace(/^(DNS|IP Address):/, ""));
}

/** Parse the listing script: a separator line with kind and path, then a certificate's PEM. */
export function parseCertificateFileListing(output: string): CertificateFileEntry[] {
  const found: CertificateFileEntry[] = [];
  for (const section of output.split(`${SEPARATOR} `).slice(1)) {
    const newline = section.indexOf("\n");
    const header = newline === -1 ? section : section.slice(0, newline);
    const space = header.indexOf(" ");
    const kind = header.slice(0, space);
    const path = header.slice(space + 1).trim();
    if (!isValidCertificateFilePath(path)) continue;
    if (kind === "key") {
      found.push({ path, kind });
      continue;
    }
    if (kind !== "certificate") continue;
    const [leaf] = section.slice(newline + 1).match(PEM_CERTIFICATE) ?? [];
    if (!leaf) continue;
    try {
      const cert = new X509Certificate(leaf);
      found.push({
        path,
        kind,
        names: certificateNames(cert),
        notAfter: new Date(cert.validTo).toISOString(),
        fingerprint: cert.fingerprint256,
      });
    } catch {
      // Not a certificate this can read; leave it out rather than fail the whole listing.
    }
  }
  // certbot's `live/` before its `archive/`, which holds every past renewal too.
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export type ReadFile = { status: "ok"; content: string } | { status: CertificateFileError };

/** Parse the read script: per argument, a separator with its 1-based index and a status. */
export function parseCertificateFileRead(output: string, count: number): ReadFile[] {
  const files: ReadFile[] = Array.from({ length: count }, () => ({ status: "not-found" }));
  for (const section of output.split(`${SEPARATOR} `).slice(1)) {
    const newline = section.indexOf("\n");
    const [index, status] = (newline === -1 ? section : section.slice(0, newline)).split(" ");
    const slot = Number(index) - 1;
    if (!Number.isInteger(slot) || slot < 0 || slot >= count) continue;
    if (status === "ok") {
      const content = newline === -1 ? "" : section.slice(newline + 1);
      files[slot] =
        Buffer.byteLength(content) > CERTIFICATE_FILE_MAX_BYTES + 1
          ? { status: "too-large" }
          : { status: "ok", content };
    } else if (status === "outside-directory" || status === "not-found") {
      files[slot] = { status };
    }
  }
  return files;
}

/** The chain and key as they will be stored, or why they cannot be. Checked again upstream. */
export function certificatePair(
  certificateFile: string,
  keyFile: string,
):
  | { ok: true; certificatePem: string; keyPem: string; fingerprint: string }
  | { ok: false; error: CertificateFileError } {
  const blocks = certificateFile.match(PEM_CERTIFICATE) ?? [];
  const [first] = blocks;
  if (!first) return { ok: false, error: "not-a-certificate" };
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(first);
    for (const block of blocks.slice(1)) new X509Certificate(block);
  } catch {
    return { ok: false, error: "not-a-certificate" };
  }
  const keyPem = PEM_KEY.exec(keyFile)?.[0];
  if (!keyPem) return { ok: false, error: "not-a-key" };
  try {
    if (!leaf.checkPrivateKey(createPrivateKey(keyPem)))
      return { ok: false, error: "key-mismatch" };
  } catch {
    return { ok: false, error: "not-a-key" };
  }
  if (certificateNames(leaf).length === 0) return { ok: false, error: "no-names" };
  const certificatePem = blocks.join("\n");
  return {
    ok: true,
    certificatePem,
    keyPem,
    fingerprint: createHash("sha256").update(certificatePem).digest("hex"),
  };
}

export async function listCertificateFiles(
  config: AgentConfig,
  docker: DockerHost,
): Promise<CertificateFileEntry[] | null> {
  if (!config.certFilesHostDir) return null;
  const result = await docker.runInCertificateDirectory(config.certFilesHostDir, [
    "sh",
    "-c",
    LIST_SCRIPT,
  ]);
  return result.ok ? parseCertificateFileListing(result.output) : null;
}

/** Every PEM included; the poller decides what to leave out. */
export async function readCertificateFiles(
  config: AgentConfig,
  docker: DockerHost,
  sources: CertificateFileSource[],
): Promise<CertificateFileResult[]> {
  const fail = (id: number, error: CertificateFileError): CertificateFileResult => ({
    id,
    ok: false,
    error,
  });
  if (!config.certFilesHostDir) return sources.map((s) => fail(s.id, "not-configured"));

  const valid = sources.filter(
    (s) => isValidCertificateFilePath(s.certPath) && isValidCertificateFilePath(s.keyPath),
  );
  const paths = [...new Set(valid.flatMap((s) => [s.certPath, s.keyPath]))];
  const files = new Map<string, ReadFile>();
  if (paths.length > 0) {
    const result = await docker.runInCertificateDirectory(config.certFilesHostDir, [
      "sh",
      "-c",
      READ_SCRIPT,
      "cpm",
      ...paths,
    ]);
    if (!result.ok) {
      return sources.map((s) =>
        valid.includes(s) ? fail(s.id, "unavailable") : fail(s.id, "invalid-path"),
      );
    }
    parseCertificateFileRead(result.output, paths.length).forEach((file, index) => {
      files.set(paths[index], file);
    });
  }

  return sources.map((source) => {
    if (!valid.includes(source)) return fail(source.id, "invalid-path");
    const cert = files.get(source.certPath) ?? { status: "not-found" };
    const key = files.get(source.keyPath) ?? { status: "not-found" };
    if (cert.status !== "ok") return fail(source.id, cert.status);
    if (key.status !== "ok") return fail(source.id, key.status);
    const pair = certificatePair(cert.content, key.content);
    return pair.ok
      ? {
          id: source.id,
          ok: true,
          fingerprint: pair.fingerprint,
          certificatePem: pair.certificatePem,
          keyPem: pair.keyPem,
        }
      : fail(source.id, pair.error);
  });
}

function sameSources(a: CertificateFileSource[], b: CertificateFileSource[]): boolean {
  const key = (list: CertificateFileSource[]) =>
    JSON.stringify([...list].sort((x, y) => x.id - y.id));
  return key(a) === key(b);
}

/**
 * Leaves out the PEM the controller already holds, so a poll that finds nothing new sends a few
 * bytes per certificate. Batched to stay under the controller's request cap.
 */
export function withoutKnownPem(
  results: CertificateFileResult[],
  sent: ReadonlyMap<number, string>,
): CertificateFileResult[][] {
  const batches: CertificateFileResult[][] = [[]];
  let size = 0;
  for (const result of results) {
    const entry: CertificateFileResult =
      result.ok && sent.get(result.id) === result.fingerprint
        ? { id: result.id, ok: true, fingerprint: result.fingerprint }
        : result;
    const bytes = JSON.stringify(entry).length;
    if (size > 0 && size + bytes > POST_BATCH_BYTES) {
      batches.push([]);
      size = 0;
    }
    batches[batches.length - 1].push(entry);
    size += bytes;
  }
  return batches.filter((batch) => batch.length > 0);
}

export type CertificateFilesPost = (
  results: CertificateFileResult[],
) => Promise<CertificateFilesAck>;

/** Reads on a change of sources, every six hours, and whenever asked; one read at a time. */
export class CertificateFilePoller {
  private sources: CertificateFileSource[] = [];
  /** id -> the fingerprint the controller acknowledged. In memory: a restart resends once. */
  private readonly sent = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly docker: DockerHost,
    private readonly post: CertificateFilesPost,
  ) {}

  /** From each desired-state frame. Unchanged sources do nothing, so a reconnect costs no read. */
  update(sources: CertificateFileSource[]): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), CERTIFICATE_FILES_POLL_MS);
      this.timer.unref();
    } else if (sameSources(sources, this.sources)) {
      return;
    }
    this.sources = sources;
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sources = [];
    this.sent.clear();
  }

  poll(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.poll();
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    if (this.sources.length === 0) return;
    const results = await readCertificateFiles(this.config, this.docker, this.sources);
    for (const batch of withoutKnownPem(results, this.sent)) {
      let ack: CertificateFilesAck;
      try {
        ack = await this.post(batch);
      } catch (error) {
        console.warn("[agent] could not send certificate files to the controller:", error);
        return;
      }
      for (const result of batch) {
        if (result.ok) this.sent.set(result.id, result.fingerprint);
        else this.sent.delete(result.id);
      }
      // The controller lacks that version (a restore, or a row it recreated): send it whole.
      for (const id of ack.resend) this.sent.delete(id);
      if (ack.resend.length > 0) this.again = true;
    }
  }
}
