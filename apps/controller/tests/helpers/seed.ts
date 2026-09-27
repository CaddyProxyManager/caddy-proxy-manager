/**
 * The web image is a compiled binary with no Bun CLI, so seeding runs in the throwaway `db-seed`
 * container. The scripts below are source text sent there, using Bun.SQL rather than drizzle:
 * db-seed has no app bundle, and the point is rows the app did not write.
 */
import { execFileSync } from 'node:child_process';
import { COMPOSE_ARGS, COMPOSE_CWD } from './compose';

/** Matches tests/e2e.env. */
const DB = 'postgres://cpm:e2e-postgres-password@postgres:5432/cpm';

const PRELUDE = `
    import { SQL } from "bun";
    const sql = new SQL({ url: ${JSON.stringify(DB)}, max: 1 });
`;

/** `--no-deps` so seeding never starts the stack, `-T` because there is no TTY. */
export function runSeedScript(script: string): string {
  return execFileSync(
    'docker',
    [...COMPOSE_ARGS, 'run', '--rm', '--no-deps', '-T', 'db-seed', '-e', `${PRELUDE}${script}`],
    { cwd: COMPOSE_CWD, stdio: 'pipe', encoding: 'utf8' },
  );
}

/** Writes both rows: Better Auth reads the `credential` account, the dashboard the `users` row. */
export function ensureTestUser(username: string, password: string, role: string): void {
  runSeedScript(`
    const email = ${JSON.stringify(`${username}@localhost`)};
    const hash = await Bun.password.hash(${JSON.stringify(password)}, { algorithm: "argon2id" });
    const now = new Date().toISOString();
    const [existing] = await sql\`SELECT id FROM users WHERE email = \${email}\`;
    if (existing) {
      await sql\`UPDATE users SET "passwordHash" = \${hash}, role = \${${JSON.stringify(role)}},
                status = 'active', "updatedAt" = \${now} WHERE email = \${email}\`;
      const [acc] = await sql\`SELECT id FROM accounts
                              WHERE "userId" = \${existing.id} AND "providerId" = 'credential'\`;
      if (acc) {
        await sql\`UPDATE accounts SET password = \${hash}, "updatedAt" = \${now} WHERE id = \${acc.id}\`;
      } else {
        await sql\`INSERT INTO accounts ("userId", "accountId", "providerId", password, "createdAt", "updatedAt")
                   VALUES (\${existing.id}, \${String(existing.id)}, 'credential', \${hash}, \${now}, \${now})\`;
      }
    } else {
      const [user] = await sql\`
        INSERT INTO users (email, name, "passwordHash", role, provider, subject, username, status, "createdAt", "updatedAt")
        VALUES (\${email}, \${${JSON.stringify(username)}}, \${hash}, \${${JSON.stringify(role)}}, 'credentials',
                \${${JSON.stringify(username)}}, \${${JSON.stringify(username)}}, 'active', \${now}, \${now})
        RETURNING id\`;
      await sql\`INSERT INTO accounts ("userId", "accountId", "providerId", password, "createdAt", "updatedAt")
                 VALUES (\${user.id}, \${String(user.id)}, 'credential', \${hash}, \${now}, \${now})\`;
    }
    await sql.close();
  `);
}

export function setUserStatus(email: string, status: 'active' | 'disabled'): void {
  runSeedScript(`
    await sql\`UPDATE users SET status = \${${JSON.stringify(status)}},
              "updatedAt" = \${new Date().toISOString()} WHERE email = \${${JSON.stringify(email)}}\`;
    await sql.close();
  `);
}

/** Stores only the SHA-256 hash, like the app, so the return value is the only plaintext copy. */
export function createApiToken(email: string, name: string, token: string): string {
  runSeedScript(`
    const { createHash } = await import("node:crypto");
    const [user] = await sql\`SELECT id FROM users WHERE email = \${${JSON.stringify(email)}}\`;
    if (!user) { console.error("User not found: " + ${JSON.stringify(email)}); process.exit(1); }
    const hash = createHash("sha256").update(${JSON.stringify(token)}).digest("hex");
    await sql\`INSERT INTO api_tokens (name, "tokenHash", "createdBy", "createdAt")
               VALUES (\${${JSON.stringify(name)}}, \${hash}, \${user.id}, \${new Date().toISOString()})\`;
    await sql.close();
  `);
  return token;
}

export type SeededUserRecord = {
  email: string;
  provider: string | null;
  subject: string | null;
  username: string | null;
  displayUsername: string | null;
  accountProviderId: string | null;
  accountId: string | null;
  accountHasPassword: boolean;
  role: string;
};

/** Read a user and its credential account back, for assertions about signup. */
export function getUserRecord(email: string): SeededUserRecord {
  const output = runSeedScript(`
    const [user] = await sql\`
      SELECT id, email, provider, subject, username, "displayUsername", role
      FROM users WHERE email = \${${JSON.stringify(email)}}\`;
    if (!user) {
      console.error("User not found");
      process.exit(1);
    }
    const [account] = await sql\`
      SELECT "providerId", "accountId", password FROM accounts
      WHERE "userId" = \${user.id} AND "providerId" = 'credential'\`;
    console.log(JSON.stringify({
      email: user.email,
      provider: user.provider,
      subject: user.subject,
      username: user.username,
      displayUsername: user.displayUsername,
      accountProviderId: account?.providerId ?? null,
      accountId: account?.accountId ?? null,
      accountHasPassword: !!account?.password,
      role: user.role,
    }));
    await sql.close();
  `).trim();

  // `docker compose run` interleaves its progress lines with the container's stdout.
  const json = output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  return JSON.parse(json) as SeededUserRecord;
}

/** Legacy-gate fixtures cannot be made through the UI, so both rows are planted with bcrypt. */
export function downgradeUserToBcrypt(email: string, password: string): void {
  runSeedScript(`
    const hash = await Bun.password.hash(${JSON.stringify(password)}, { algorithm: "bcrypt", cost: 10 });
    const now = new Date().toISOString();
    const [user] = await sql\`SELECT id FROM users WHERE email = \${${JSON.stringify(email)}}\`;
    if (!user) {
      console.error("User not found");
      process.exit(1);
    }
    await sql\`UPDATE users SET "passwordHash" = \${hash}, "updatedAt" = \${now} WHERE id = \${user.id}\`;
    await sql\`UPDATE accounts SET password = \${hash}, "updatedAt" = \${now}
              WHERE "userId" = \${user.id} AND "providerId" = 'credential'\`;
    await sql.close();
  `);
}

/** The algorithm prefix of a user's stored hash, e.g. "$argon2id" or "$2b". */
export function getUserHashAlgorithm(email: string): string {
  const output = runSeedScript(`
    const [user] = await sql\`SELECT "passwordHash" FROM users WHERE email = \${${JSON.stringify(email)}}\`;
    console.log("HASH:" + (user?.passwordHash ?? "").split("$").slice(0, 2).join("$"));
    await sql.close();
  `);
  // Prefixed for the same reason getUserRecord slices its JSON.
  const line = output.split('\n').find((l) => l.includes('HASH:')) ?? '';
  return line.slice(line.indexOf('HASH:') + 'HASH:'.length).trim();
}

/** Write a settings row directly, for policies with no seeding API of their own. */
export function setSettingRow(key: string, value: unknown): void {
  runSeedScript(`
    await sql\`
      INSERT INTO settings (key, value, "updatedAt")
      VALUES (\${${JSON.stringify(key)}}, \${${JSON.stringify(JSON.stringify(value))}}, \${new Date().toISOString()})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"\`;
    await sql.close();
  `);
}

export function clearSettingRow(key: string): void {
  runSeedScript(`
    await sql\`DELETE FROM settings WHERE key = \${${JSON.stringify(key)}}\`;
    await sql.close();
  `);
}

/** Turn off a user's 2FA, so a spec that enrols one can run again. */
export function resetTwoFactor(email: string): void {
  runSeedScript(`
    const [user] = await sql\`SELECT id FROM users WHERE email = \${${JSON.stringify(email)}}\`;
    if (user) {
      await sql\`DELETE FROM two_factors WHERE "userId" = \${user.id}\`;
      await sql\`UPDATE users SET "twoFactorEnabled" = false WHERE id = \${user.id}\`;
    }
    await sql.close();
  `);
}
