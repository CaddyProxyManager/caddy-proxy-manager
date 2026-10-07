/**
 * The air-gap bundle's manifest: which of our images it carries, which third-party images the
 * operator brings in themselves (by digest, from docker-compose.yml), and every published file's
 * checksum. Plain lines rather than JSON so the load script can read it with nothing but sh.
 *
 *   version <x.y.z>
 *   arch <amd64|arm64>
 *   image <service> <reference> <sha256> <file>        the joined docker save archive
 *   third-party <service> <reference@sha256:...>
 *   file <sha256> <bytes> <name>                       every published asset but the manifest
 */

/** Built and published by CPM; everything else in the compose file is someone else's image. */
export const FIRST_PARTY_SERVICES = ["web", "caddy", "agent"] as const;
export type FirstPartyService = (typeof FIRST_PARTY_SERVICES)[number];

/** GitHub refuses a release asset of 2 GiB or more. */
export const ASSET_LIMIT_BYTES = 2 * 1024 ** 3;
/** What `split -b` cuts an oversized asset into, comfortably below the limit. */
export const PART_SIZE = "1900M";

export type ComposeImage = { service: string; image: string };
export type ThirdPartyImage = ComposeImage & { digest: string | null };
export type BundledImage = {
  service: FirstPartyService;
  image: string;
  sha256: string;
  file: string;
};
export type BundleFile = { sha256: string; bytes: number; name: string };
export type Manifest = {
  version: string;
  arch: string;
  images: BundledImage[];
  thirdParty: ThirdPartyImage[];
  files: BundleFile[];
};

const FIRST_PARTY_IMAGE = /^ghcr\.io\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/(web|caddy|agent):/;
const DIGEST = /@(sha256:[0-9a-f]{64})$/;

/**
 * Each service's `image:` in a compose file, with a `${VAR:-default}` read as its default - what
 * runs when nothing overrides it. Lines, not a YAML parser: the site's build reads this under Node.
 */
export function composeImages(compose: string): ComposeImage[] {
  const images: ComposeImage[] = [];
  let inServices = false;
  let service: string | null = null;
  for (const line of compose.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      service = null;
      continue;
    }
    if (!inServices) continue;
    const key = /^ {2}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (key) {
      service = key[1];
      continue;
    }
    const image = /^ {4}image:\s*(\S+)\s*$/.exec(line);
    if (image && service) {
      const value = image[1].replace(/^["']|["']$/g, "");
      const fallback = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-(.*)\}$/.exec(value);
      images.push({ service, image: fallback ? fallback[1] : value });
    }
  }
  return images;
}

export function isFirstPartyImage(image: string): boolean {
  return FIRST_PARTY_IMAGE.test(image);
}

/** The images an operator fetches through their own channel, in compose file order. */
export function thirdPartyImages(compose: string): ThirdPartyImage[] {
  return composeImages(compose)
    .filter(({ image }) => !isFirstPartyImage(image))
    .map(({ service, image }) => ({ service, image, digest: DIGEST.exec(image)?.[1] ?? null }));
}

export function renderManifest(manifest: Manifest): string {
  const lines = [
    "# Caddy Proxy Manager air-gap bundle. Check this file's signature before its checksums.",
    `version ${manifest.version}`,
    `arch ${manifest.arch}`,
    ...manifest.images.map((i) => `image ${i.service} ${i.image} ${i.sha256} ${i.file}`),
    ...manifest.thirdParty.map((i) => `third-party ${i.service} ${i.image}`),
    ...manifest.files.map((f) => `file ${f.sha256} ${f.bytes} ${f.name}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function parseManifest(text: string): Manifest {
  const manifest: Manifest = { version: "", arch: "", images: [], thirdParty: [], files: [] };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const [kind, ...fields] = line.trim().split(/\s+/);
    switch (kind) {
      case "version":
        manifest.version = fields[0];
        break;
      case "arch":
        manifest.arch = fields[0];
        break;
      case "image": {
        const [service, image, sha256, file] = fields;
        if (!(FIRST_PARTY_SERVICES as readonly string[]).includes(service)) {
          throw new Error(`manifest: ${service} is not one of our images`);
        }
        manifest.images.push({ service: service as FirstPartyService, image, sha256, file });
        break;
      }
      case "third-party": {
        const [service, image] = fields;
        manifest.thirdParty.push({ service, image, digest: DIGEST.exec(image)?.[1] ?? null });
        break;
      }
      case "file": {
        const [sha256, bytes, name] = fields;
        manifest.files.push({ sha256, bytes: Number(bytes), name });
        break;
      }
      default:
        throw new Error(`manifest: unknown line "${line}"`);
    }
  }
  return manifest;
}
