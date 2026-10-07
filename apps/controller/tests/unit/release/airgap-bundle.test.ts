/**
 * The air-gap bundle against the compose file it ships beside: every third-party image pinned by
 * digest and listed in the manifest exactly, a dry run of the packaging, and the load script's
 * refusals. Docker is a stub that answers from files, so nothing here touches a daemon; the
 * signature is CI's (Sigstore needs the workflow's identity) and is checked there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSET_LIMIT_BYTES,
  composeImages,
  FIRST_PARTY_SERVICES,
  parseManifest,
  renderManifest,
  thirdPartyImages,
} from '../../../../../scripts/airgap/manifest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const COMPOSE = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf-8');
const VERSION = '9.8.7';
const PREFIX = `caddy-proxy-manager-v${VERSION}-amd64-airgap`;

describe('third-party images in docker-compose.yml', () => {
  it('are every image but our three, read the way a YAML parser reads them', () => {
    const parsed = Bun.YAML.parse(COMPOSE) as { services: Record<string, { image?: string }> };
    const fromYaml = Object.entries(parsed.services)
      .filter(([, service]) => service.image)
      .map(([service, { image }]) => ({
        service,
        image: (image as string).replace(/^\$\{[A-Z_]+:-(.*)\}$/, '$1'),
      }));
    expect(composeImages(COMPOSE)).toEqual(fromYaml);
    expect(composeImages(COMPOSE).length - thirdPartyImages(COMPOSE).length).toBe(
      FIRST_PARTY_SERVICES.length,
    );
  });

  it('are each pinned by digest', () => {
    const images = thirdPartyImages(COMPOSE);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.digest, `${image.service}: ${image.image}`).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('reads a default out of a variable, and keeps a quoted reference', () => {
    const variable = ['$', '{CADDY_IMAGE:-ghcr.io/owner/caddy:latest}'].join('');
    const compose = [
      'services:',
      '  caddy:',
      `    image: ${variable}`,
      '  db:',
      `    image: "postgres:18@sha256:${'a'.repeat(64)}"`,
      'volumes:',
      '  image:',
    ].join('\n');
    expect(composeImages(compose)).toEqual([
      { service: 'caddy', image: 'ghcr.io/owner/caddy:latest' },
      { service: 'db', image: `postgres:18@sha256:${'a'.repeat(64)}` },
    ]);
    expect(thirdPartyImages(compose)).toEqual([
      {
        service: 'db',
        image: `postgres:18@sha256:${'a'.repeat(64)}`,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    ]);
  });
});

describe('the manifest format', () => {
  it('round-trips, and refuses an image that is not ours or a line it does not know', () => {
    const manifest = {
      version: VERSION,
      arch: 'arm64',
      images: [
        { service: 'web' as const, image: 'ghcr.io/o/web:1', sha256: 'ab', file: 'w.tar.gz' },
      ],
      thirdParty: thirdPartyImages(COMPOSE),
      files: [{ sha256: 'cd', bytes: 12, name: 'w.tar.gz' }],
    };
    expect(parseManifest(renderManifest(manifest))).toEqual(manifest);
    expect(() => parseManifest('image postgres x y z')).toThrow(/not one of our images/);
    expect(() => parseManifest('signature abc')).toThrow(/unknown line/);
  });
});

// The stub reads and writes $FAKE_DOCKER_STATE: `present` lists the references a host has,
// `compose-images` what `compose config --images` prints, `calls` every invocation.
const FAKE_DOCKER = `#!/usr/bin/env bash
state="$FAKE_DOCKER_STATE"
echo "$*" >> "$state/calls"
case "$1" in
  info) echo "\${FAKE_DOCKER_ARCH:-x86_64}" ;;
  image)
    shift 2
    if [ "$1" = --format ]; then format="$2"; shift 2; fi
    grep -qxF "$1" "$state/present" || exit 1
    [ -z "\${format:-}" ] || echo linux/amd64 ;;
  save) head -c "\${FAKE_SAVE_BYTES:-3000}" /dev/urandom ;;
  load) cat >/dev/null; cat "$state/loadable" >> "$state/present" ;;
  compose) cat "$state/compose-images" ;;
  *) exit 64 ;;
esac
`;

// Spawns argv with the stub first on PATH. Needs bash, gzip, split and tar, as the release runner has.
const posix = process.platform !== 'win32' && Bun.which('bash') !== null;
const posixDescribe = posix ? describe : describe.skip;

posixDescribe('a dry run of the packaging and the load script', () => {
  let work: string;
  let state: string;
  let bin: string;
  let bundle: string;
  let deploy: string;
  const firstParty = FIRST_PARTY_SERVICES.map((s) => `ghcr.io/caddyproxymanager/${s}:${VERSION}`);
  const thirdParty = thirdPartyImages(COMPOSE).map((i) => i.image);

  async function run(argv: string[], cwd: string, env: Record<string, string> = {}) {
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, ...env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  function host(present: string[], composeImages = [...firstParty, ...thirdParty]) {
    writeFileSync(join(state, 'present'), `${present.join('\n')}\n`);
    writeFileSync(join(state, 'loadable'), `${firstParty.join('\n')}\n`);
    writeFileSync(join(state, 'compose-images'), `${composeImages.join('\n')}\n`);
    writeFileSync(join(state, 'calls'), '');
  }

  const load = (env: Record<string, string> = {}) =>
    run(['sh', join(deploy, 'airgap-load.sh'), bundle], deploy, env);

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'cpm-airgap-'));
    state = join(work, 'state');
    bin = join(work, 'bin');
    bundle = join(work, 'bundle');
    deploy = join(work, 'deploy');
    for (const dir of [state, bin, deploy]) mkdirSync(dir);
    writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
    host(firstParty);

    // 3000 random bytes gzip to a little more, so a 2500-byte limit splits every image.
    const packaged = await run(
      [
        'bun',
        'scripts/airgap/package.ts',
        '--version',
        VERSION,
        '--arch',
        'amd64',
        '--out',
        bundle,
        '--split-limit',
        '2500',
        '--part-size',
        '1000',
      ],
      ROOT,
    );
    expect(packaged.stderr).not.toContain('error');
    expect(packaged.code).toBe(0);
    const archive = join(bundle, `${PREFIX}-deploy.tar.gz`);
    expect((await run(['tar', '-xzf', archive, '-C', deploy], work)).code).toBe(0);
  }, 60_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const manifest = () =>
    parseManifest(readFileSync(join(bundle, `${PREFIX}-manifest.txt`), 'utf-8'));

  it('lists every published file with its checksum, and nothing else', () => {
    const published = readdirSync(bundle)
      .filter((name) => !name.endsWith('-manifest.txt'))
      .sort();
    const { files } = manifest();
    expect(files.map((f) => f.name)).toEqual(published);
    for (const file of files) {
      expect(sha256(join(bundle, file.name)), file.name).toBe(file.sha256);
      expect(statSync(join(bundle, file.name)).size).toBe(file.bytes);
      expect(file.bytes).toBeLessThan(ASSET_LIMIT_BYTES);
    }
  });

  it('splits an archive over the limit, and the parts join to the checksum the image line names', () => {
    const { images } = manifest();
    expect(images.map((i) => i.image)).toEqual(firstParty);
    for (const image of images) {
      const parts = readdirSync(bundle)
        .filter((name) => name.startsWith(`${image.file}.part-`))
        .sort();
      expect(parts.length, image.file).toBeGreaterThan(1);
      for (const part of parts) expect(statSync(join(bundle, part)).size).toBeLessThanOrEqual(1000);
      const joined = createHash('sha256');
      for (const part of parts) joined.update(readFileSync(join(bundle, part)));
      expect(joined.digest('hex')).toBe(image.sha256);
    }
  });

  it('names exactly the third-party images docker-compose.yml pins', () => {
    expect(manifest().thirdParty).toEqual(thirdPartyImages(COMPOSE));
  });

  it('ships the load script and a compose file pinned to the release', () => {
    expect(statSync(join(deploy, 'airgap-load.sh')).mode & 0o111).not.toBe(0);
    const compose = readFileSync(join(deploy, 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain(`ghcr.io/caddyproxymanager/web:${VERSION}`);
    expect(compose).not.toContain('./docker/');
  });

  it('loads our images and starts nothing when every third-party image is here', async () => {
    host(thirdParty);
    const result = await load();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const calls = readFileSync(join(state, 'calls'), 'utf-8');
    expect(calls.match(/^load$/gm)).toHaveLength(FIRST_PARTY_SERVICES.length);
    expect(calls).not.toMatch(/^(pull|compose .* up|run) /m);
  });

  it('refuses, naming the image, when a third-party image is missing', async () => {
    const [missing, ...rest] = thirdPartyImages(COMPOSE);
    host(rest.map((i) => i.image));
    const result = await load();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${missing.service}: ${missing.image}`);
    expect(result.stderr).toContain('Nothing was started');
  });

  it('refuses when an override names another digest', async () => {
    const [changed] = thirdPartyImages(COMPOSE);
    const other = changed.image.replace(/sha256:[0-9a-f]+$/, `sha256:${'0'.repeat(64)}`);
    host([...thirdParty, other], [...firstParty, other, ...thirdParty.slice(1)]);
    const result = await load();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `${changed.service}: the compose files no longer name ${changed.image}`,
    );
  });

  it('accepts a private registry name that keeps the digest', async () => {
    const [moved] = thirdPartyImages(COMPOSE);
    const mirrored = `registry.example.internal/${moved.image.split('/').pop()}`;
    host([mirrored, ...thirdParty.slice(1)], [...firstParty, mirrored, ...thirdParty.slice(1)]);
    const result = await load();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('names a corrupt download before loading anything', async () => {
    host(thirdParty);
    const victim = manifest().files.find((f) => f.name.endsWith('-caddy.tar.gz.part-aa'));
    if (!victim) throw new Error('no caddy part');
    const path = join(bundle, victim.name);
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from('x')]));
    try {
      const result = await load();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`corrupt:  ${victim.name}`);
      expect(readFileSync(join(state, 'calls'), 'utf-8')).not.toMatch(/^load$/m);
    } finally {
      writeFileSync(path, original);
    }
  });

  it('refuses a bundle for another architecture', async () => {
    host(thirdParty);
    const result = await load({ FAKE_DOCKER_ARCH: 'aarch64' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('this bundle is for amd64, but Docker here runs arm64');
  });
});
