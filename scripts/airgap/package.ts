/**
 * Builds one architecture's air-gap bundle from images already present locally under their release
 * names: a `docker save` archive per first-party image, the deploy files with the load script, and
 * the manifest. Third-party images are listed by digest, never bundled. Signing is the caller's.
 *
 *   bun scripts/airgap/package.ts --version 4.0.0 --arch amd64 --out dist/airgap
 *       [--image-base ghcr.io/caddyproxymanager] [--split-limit <bytes>] [--part-size 1900M]
 *
 * Run from the repository root. The tar, gzip and split CLIs do the heavy lifting, streaming:
 * an image archive never has to fit in memory.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  ASSET_LIMIT_BYTES,
  type BundledImage,
  type BundleFile,
  FIRST_PARTY_SERVICES,
  PART_SIZE,
  renderManifest,
  thirdPartyImages,
} from "./manifest";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    arch: { type: "string" },
    out: { type: "string" },
    "image-base": { type: "string", default: "ghcr.io/caddyproxymanager" },
    "split-limit": { type: "string", default: String(ASSET_LIMIT_BYTES) },
    "part-size": { type: "string", default: PART_SIZE },
  },
});

const version = values.version ?? "";
const arch = values.arch ?? "";
const out = values.out ?? "";
const splitLimit = Number(values["split-limit"]);
if (
  !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ||
  !["amd64", "arm64"].includes(arch) ||
  !out
) {
  console.error(
    "usage: bun scripts/airgap/package.ts --version <x.y.z> --arch <amd64|arm64> --out <dir>",
  );
  process.exit(2);
}

const prefix = `caddy-proxy-manager-v${version}-${arch}-airgap`;
mkdirSync(out, { recursive: true });

/** Relative, with forward slashes: tar reads a Windows drive path (`C:`) as a remote host. */
function shellPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "inherit" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}`);
  return stdout.trim();
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

const images: BundledImage[] = [];
for (const service of FIRST_PARTY_SERVICES) {
  const image = `${values["image-base"]}/${service}:${version}`;
  // A pull without --platform on another host's arch would bundle images that cannot start.
  const platform = await run([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Os}}/{{.Architecture}}",
    image,
  ]);
  if (platform !== `linux/${arch}`) {
    throw new Error(`${image} is ${platform}, not linux/${arch}`);
  }
  const file = `${prefix}-${service}.tar.gz`;
  const path = join(out, file);
  // bash for pipefail: a failed save must not leave a valid-looking empty gzip behind.
  await run([
    "bash",
    "-c",
    'set -euo pipefail; docker save --platform "$1" "$2" | gzip -n > "$3"',
    "save",
    `linux/${arch}`,
    image,
    shellPath(path),
  ]);
  images.push({ service, image, sha256: await sha256(path), file });

  if (statSync(path).size >= splitLimit) {
    await run([
      "split",
      "-b",
      values["part-size"] ?? PART_SIZE,
      shellPath(path),
      `${shellPath(path)}.part-`,
    ]);
    rmSync(path);
  }
}

const loadScript = join(import.meta.dir, "airgap-load.sh");
const deploy = shellPath(join(out, `${prefix}-deploy.tar.gz`));
await run(["bash", "./scripts/package-deploy.sh", version, deploy, shellPath(loadScript)]);

const files: BundleFile[] = [];
for (const name of readdirSync(out).sort()) {
  if (
    !name.startsWith(`${prefix}-`) ||
    name.endsWith("-manifest.txt") ||
    name.endsWith(".sigstore.json")
  ) {
    continue;
  }
  const path = join(out, name);
  files.push({ sha256: await sha256(path), bytes: statSync(path).size, name });
}

const over = files.filter((f) => f.bytes >= ASSET_LIMIT_BYTES);
if (over.length > 0) {
  throw new Error(`over GitHub's 2 GiB asset limit: ${over.map((f) => f.name).join(", ")}`);
}

const compose = readFileSync("docker-compose.yml", "utf-8");
const thirdParty = thirdPartyImages(compose);
const unpinned = thirdParty.filter((i) => !i.digest);
if (unpinned.length > 0) {
  throw new Error(`not pinned by digest: ${unpinned.map((i) => i.image).join(", ")}`);
}

const manifest = join(out, `${prefix}-manifest.txt`);
writeFileSync(manifest, renderManifest({ version, arch, images, thirdParty, files }));

for (const f of files) console.log(`${String(f.bytes).padStart(12)}  ${f.name}`);
console.log(`manifest: ${basename(manifest)}`);
