/**
 * Where scheduled backups are kept: an S3-compatible bucket through Bun's own client, or a folder
 * on the data volume. Both answer the same four calls, so the runner and retention never ask which.
 */
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { S3Client } from "bun";
import { domainError } from "../errors/domain-error";
import { resolveCheckedAddresses } from "../http/outbound";
import { MAX_BACKUP_BYTES } from "./format";

export type StoredObject = { key: string; size: number; lastModified: string | null };

export interface BackupStore {
  write(key: string, data: Uint8Array): Promise<void>;
  /** Refused past `MAX_BACKUP_BYTES`, the most a restore takes. */
  read(key: string): Promise<Buffer>;
  /** The first bytes only: enough for a backup's header. */
  readHead(key: string, bytes: number): Promise<Buffer>;
  /** Every key under `prefix`, however many pages that takes. */
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
}

/** S3's limit per page; also what a fake returns, to prove paging. */
export const LIST_PAGE = 1000;
/** Uploads at least this size go up in parts, each this large. 5 MiB is S3's smallest part. */
export const PART_SIZE = 8 * 1024 * 1024;

export type S3DestinationConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  virtualHostedStyle: boolean;
};

/** The calls used from Bun's S3Client, so a test can hand in a fake. */
export type S3Like = Pick<S3Client, "list" | "file" | "write" | "delete">;

function tooLarge() {
  return domainError("backupTooLarge", {}, { status: 413 });
}

/**
 * The client takes no lookup or agent, so the endpoint can't be pinned like other outbound calls:
 * its name is checked at save and again here, before each use. Only an administrator sets it.
 */
async function checkEndpoint(endpoint: string): Promise<void> {
  if (!endpoint) return;
  await resolveCheckedAddresses(new URL(endpoint).hostname);
}

/**
 * Where requests go. Virtual-hosted style puts the bucket in the host name; Bun wants that host as
 * the endpoint and then ignores `bucket`, so it is composed here from the two fields entered.
 */
export function s3Endpoint(config: S3DestinationConfig): string {
  if (!config.endpoint || !config.virtualHostedStyle) return config.endpoint;
  const url = new URL(config.endpoint);
  url.hostname = `${config.bucket}.${url.hostname}`;
  return url.toString().replace(/\/+$/, "");
}

export function s3Store(
  config: S3DestinationConfig,
  options: { client?: S3Like; partSize?: number; check?: boolean } = {},
): BackupStore {
  const endpoint = s3Endpoint(config);
  const client: S3Like =
    options.client ??
    new S3Client({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      bucket: config.bucket,
      endpoint: endpoint || undefined,
      region: config.region || undefined,
      virtualHostedStyle: config.virtualHostedStyle,
      retry: 2,
    });
  const partSize = options.partSize ?? PART_SIZE;
  const ready = () => (options.check === false ? Promise.resolve() : checkEndpoint(endpoint));
  return {
    async write(key, data) {
      await ready();
      if (data.byteLength < partSize) {
        await client.write(key, data);
        return;
      }
      // `write` documents no multipart threshold; the writer splits explicitly.
      const writer = client.file(key).writer({ partSize, queueSize: 2, retry: 2 });
      for (let offset = 0; offset < data.byteLength; offset += partSize) {
        await writer.write(data.subarray(offset, offset + partSize));
      }
      await writer.end();
    },
    async read(key) {
      await ready();
      const file = client.file(key);
      if ((await file.stat()).size > MAX_BACKUP_BYTES) throw tooLarge();
      return Buffer.from(await file.arrayBuffer());
    },
    async readHead(key, bytes) {
      await ready();
      return Buffer.from(await client.file(key).slice(0, bytes).arrayBuffer());
    },
    async list(prefix) {
      await ready();
      const objects: StoredObject[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.list({ prefix, maxKeys: LIST_PAGE, continuationToken });
        for (const item of page.contents ?? []) {
          objects.push({
            key: item.key,
            size: item.size ?? 0,
            lastModified: item.lastModified ?? null,
          });
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
      return objects;
    },
    async delete(key) {
      await ready();
      await client.delete(key);
    },
  };
}

/** The data volume, as the safety backups and the agent bootstrap token use it. */
export function dataDirectory(): string {
  return process.env.L4_PORTS_DIR || "/app/data";
}

export function localRoot(folder: string): string {
  return join(dataDirectory(), "backups", folder);
}

export function localStore(folder: string): BackupStore {
  const root = resolve(localRoot(folder));
  /** A key names a file under the root and nothing outside it. */
  const pathOf = (key: string) => {
    const path = resolve(root, key);
    if (!path.startsWith(root + sep) || key.includes("\\")) {
      throw domainError("backupObjectInvalid", {}, { status: 400 });
    }
    return path;
  };
  async function walk(dir: string, out: StoredObject[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, out);
      else if (entry.isFile() && !entry.name.endsWith(".partial")) {
        const info = await stat(path);
        out.push({
          key: relative(root, path).split(sep).join("/"),
          size: info.size,
          lastModified: info.mtime.toISOString(),
        });
      }
    }
  }
  return {
    async write(key, data) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      // Renamed into place, so a crash mid-write never leaves a truncated backup behind.
      await writeFile(`${path}.partial`, data, { mode: 0o600 });
      await rename(`${path}.partial`, path);
    },
    async read(key) {
      const path = pathOf(key);
      if ((await stat(path)).size > MAX_BACKUP_BYTES) throw tooLarge();
      return readFile(path);
    },
    async readHead(key, bytes) {
      const handle = await open(pathOf(key), "r");
      try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async list(prefix) {
      const objects: StoredObject[] = [];
      await walk(root, objects);
      return objects.filter((object) => object.key.startsWith(prefix));
    },
    async delete(key) {
      await unlink(pathOf(key));
    },
  };
}
