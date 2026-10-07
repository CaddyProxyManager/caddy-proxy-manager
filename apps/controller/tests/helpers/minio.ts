/**
 * A throwaway MinIO for the S3 destination tests, started like scripts/with-test-db.ts starts
 * PostgreSQL: a random host port, removed afterwards. MinIO's own images left Docker Hub, so this
 * uses Chainguard's build, which also ships `mc` for making the bucket.
 */
const IMAGE = process.env.TEST_MINIO_IMAGE || 'chainguard/minio:latest';
export const MINIO_USER = 'cpmtest';
export const MINIO_PASSWORD = 'cpmtest-secret-key';
export const MINIO_BUCKET = 'cpm-test';
/** So `<bucket>.localhost` reaches it virtual-hosted style. */
const DOMAIN = 'localhost';

export type Minio = { endpoint: string; port: string; stop: () => Promise<void> };

async function docker(args: string[]) {
  // Git Bash would rewrite the container paths below (MSYS path conversion).
  const proc = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Why MinIO can't run here, or null: the tests skip with this rather than fail. */
export async function minioUnavailable(): Promise<string | null> {
  try {
    const info = await docker(['info', '--format', '{{.ServerVersion}}']);
    return info.code === 0 ? null : `Docker is not available: ${info.stderr || info.stdout}`;
  } catch (error) {
    return `Docker is not available: ${String(error)}`;
  }
}

export async function startMinio(): Promise<Minio> {
  const name = `cpm-test-minio-${process.pid}-${Date.now()}`;
  const run = await docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-e',
    `MINIO_ROOT_USER=${MINIO_USER}`,
    '-e',
    `MINIO_ROOT_PASSWORD=${MINIO_PASSWORD}`,
    '-e',
    `MINIO_DOMAIN=${DOMAIN}`,
    '-p',
    '0:9000',
    '--tmpfs',
    '/data',
    IMAGE,
    'server',
    '/data',
  ]);
  if (run.code !== 0) throw new Error(`Could not start ${IMAGE}: ${run.stderr || run.stdout}`);
  const stop = async () => {
    await docker(['rm', '-f', name]);
  };
  try {
    const port = (await docker(['port', name, '9000/tcp'])).stdout.split('\n')[0]?.split(':').pop();
    if (!port) throw new Error('Could not read the MinIO container port');
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ready = await fetch(`${endpoint}/minio/health/ready`).then(
        (res) => res.ok,
        () => false,
      );
      if (ready) break;
      if (Date.now() > deadline) throw new Error('MinIO was not ready within 60s');
      await Bun.sleep(250);
    }
    const mc = (args: string[]) => docker(['exec', name, 'mc', ...args]);
    const alias = await mc([
      'alias',
      'set',
      'local',
      'http://127.0.0.1:9000',
      MINIO_USER,
      MINIO_PASSWORD,
    ]);
    if (alias.code !== 0) throw new Error(`mc alias failed: ${alias.stderr || alias.stdout}`);
    const bucket = await mc(['mb', `local/${MINIO_BUCKET}`]);
    if (bucket.code !== 0) throw new Error(`mc mb failed: ${bucket.stderr || bucket.stdout}`);
    return { endpoint, port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
