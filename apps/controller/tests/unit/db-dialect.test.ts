/**
 * Every pre-3.0 SQLite spelling must name the same file. The field form exists because Compose
 * cannot URL-encode a password, and `openssl rand -base64` often emits a `/` that ends the URL's
 * authority early.
 */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { databaseDialect, driverOptions, resolveDatabaseTarget } from '../../src/lib/db/dialect';

/** Only what the test sets: the real environment must not decide what these assert. */
function env(values: Record<string, string | undefined>) {
  return values;
}

describe('resolveDatabaseTarget', () => {
  describe('DATABASE_URL, when it is set', () => {
    it('recognizes both spellings of the scheme', () => {
      expect(
        resolveDatabaseTarget(env({ DATABASE_URL: 'postgres://user:pw@db:5432/cpm' })),
      ).toEqual({ kind: 'url', url: 'postgres://user:pw@db:5432/cpm' });
      expect(
        resolveDatabaseTarget(env({ DATABASE_URL: 'postgresql://user:pw@db:5432/cpm' })).kind,
      ).toBe('url');
    });

    it('is case insensitive about the scheme', () => {
      const target = resolveDatabaseTarget(env({ DATABASE_URL: 'POSTGRES://user:pw@db/cpm' }));
      expect(target).toEqual({ kind: 'url', url: 'POSTGRES://user:pw@db/cpm' });
    });

    it('passes the URL through untouched for the driver to parse', () => {
      const url = 'postgres://user:p%40ss@db:5432/cpm?sslmode=require';
      expect(resolveDatabaseTarget(env({ DATABASE_URL: url }))).toEqual({ kind: 'url', url });
    });

    it('trims surrounding whitespace, which .env files pick up easily', () => {
      const target = resolveDatabaseTarget(env({ DATABASE_URL: '  postgres://db/cpm  ' }));
      expect(target).toEqual({ kind: 'url', url: 'postgres://db/cpm' });
    });

    it('wins over the fields, since it is the escape hatch for what they cannot say', () => {
      const target = resolveDatabaseTarget(
        env({ DATABASE_URL: 'postgres://db/cpm', POSTGRES_PASSWORD: 'ignored' }),
      );
      expect(target).toEqual({ kind: 'url', url: 'postgres://db/cpm' });
    });
  });

  describe('the POSTGRES_* fields', () => {
    it('takes a password with the characters that broke it as a URL', () => {
      // The reported failure: as a URL the host becomes "cpm:pa".
      const target = resolveDatabaseTarget(env({ POSTGRES_PASSWORD: 'pa/ss+wo=rd' }));
      expect(target).toMatchObject({ kind: 'fields', password: 'pa/ss+wo=rd' });
    });

    it('leaves @ ? # and % alone too, none of which delimit anything here', () => {
      const password = 'p@ss?w#rd%2F/';
      expect(resolveDatabaseTarget(env({ POSTGRES_PASSWORD: password }))).toMatchObject({
        password,
      });
    });

    it('defaults the rest to the bundled stack, so a password is enough', () => {
      expect(resolveDatabaseTarget(env({ POSTGRES_PASSWORD: 'pw' }))).toEqual({
        kind: 'fields',
        hostname: 'postgres',
        port: 5432,
        username: 'cpm',
        password: 'pw',
        database: 'cpm',
        tls: false,
      });
    });

    it('takes an external server', () => {
      const target = resolveDatabaseTarget(
        env({
          POSTGRES_HOST: 'db.example.com',
          POSTGRES_PORT: '6432',
          POSTGRES_USER: 'proxy',
          POSTGRES_PASSWORD: 'pw',
          POSTGRES_DB: 'manager',
          POSTGRES_SSL: 'true',
        }),
      );
      expect(target).toEqual({
        kind: 'fields',
        hostname: 'db.example.com',
        port: 6432,
        username: 'proxy',
        password: 'pw',
        database: 'manager',
        tls: true,
      });
    });

    it('treats a blank variable as unset, which .env files produce easily', () => {
      const target = resolveDatabaseTarget(
        env({ POSTGRES_PASSWORD: 'pw', POSTGRES_HOST: '   ', POSTGRES_DB: '' }),
      );
      expect(target).toMatchObject({ hostname: 'postgres', database: 'cpm' });
    });

    it('refuses a port that is not one rather than quietly defaulting past it', () => {
      // Falling back to 5432 would hide a one-character typo behind a connection error.
      for (const port of ['abc', '0', '70000', '5432.5', '']) {
        const values = env({ POSTGRES_PASSWORD: 'pw', POSTGRES_PORT: port });
        if (port === '') {
          expect(resolveDatabaseTarget(values)).toMatchObject({ port: 5432 });
        } else {
          expect(() => resolveDatabaseTarget(values)).toThrow(/POSTGRES_PORT/);
        }
      }
    });

    it('refuses a POSTGRES_SSL it cannot read as on or off', () => {
      expect(() =>
        resolveDatabaseTarget(env({ POSTGRES_PASSWORD: 'pw', POSTGRES_SSL: 'verify-full' })),
      ).toThrow(/POSTGRES_SSL/);
    });
  });

  describe('SQLite', () => {
    // An old .env value must not be a startup error.
    const cwd = process.cwd();
    for (const [url, path] of [
      ['file:/app/data/caddy-proxy-manager.db', '/app/data/caddy-proxy-manager.db'],
      ['sqlite:///var/lib/cpm/app.db', '/var/lib/cpm/app.db'],
      ['file:./data/app.db', resolve(cwd, 'data/app.db')],
      ['file:data/app.db', resolve(cwd, 'data/app.db')],
      ['data/app.db', resolve(cwd, 'data/app.db')],
      ['file:/app/data/with%20space.db', '/app/data/with space.db'],
      [':memory:', ':memory:'],
      ['file::memory:', ':memory:'],
    ] as const) {
      it(`reads ${url} as a file`, () => {
        expect(resolveDatabaseTarget(env({ DATABASE_URL: url }))).toEqual({ kind: 'sqlite', path });
        expect(databaseDialect(env({ DATABASE_URL: url }))).toBe('sqlite');
      });
    }

    it('reads a Windows path as a path, not a one-letter scheme', () => {
      expect(resolveDatabaseTarget(env({ DATABASE_URL: 'C:\\data\\app.db' })).kind).toBe('sqlite');
    });

    it('refuses a file on another host rather than opening a local one', () => {
      expect(() => resolveDatabaseTarget(env({ DATABASE_URL: 'file://nas/share/app.db' }))).toThrow(
        /another host/,
      );
    });

    it('wins over the POSTGRES_* fields, like any DATABASE_URL', () => {
      expect(
        resolveDatabaseTarget(env({ DATABASE_URL: ':memory:', POSTGRES_PASSWORD: 'pw' })).kind,
      ).toBe('sqlite');
    });
  });

  describe('databaseDialect', () => {
    it('is postgres for a URL, the fields, and nothing at all - it never throws', () => {
      expect(databaseDialect(env({ DATABASE_URL: 'postgres://db/cpm' }))).toBe('postgres');
      expect(databaseDialect(env({ POSTGRES_PASSWORD: 'pw' }))).toBe('postgres');
      expect(databaseDialect(env({}))).toBe('postgres');
      expect(databaseDialect(env({ DATABASE_URL: 'redis://db' }))).toBe('postgres');
    });
  });

  describe('rejects everything else by name', () => {
    it('names the backend when it is one Bun.SQL could almost reach', () => {
      expect(() => resolveDatabaseTarget(env({ DATABASE_URL: 'mysql://user:pw@db/cpm' }))).toThrow(
        /MySQL/,
      );
      expect(() =>
        resolveDatabaseTarget(env({ DATABASE_URL: 'mariadb://user:pw@db/cpm' })),
      ).toThrow(/MariaDB/);
      expect(() => resolveDatabaseTarget(env({ DATABASE_URL: 'mongodb://db/cpm' }))).toThrow(
        /MongoDB/,
      );
    });

    it('reports the scheme it did not recognize', () => {
      expect(() => resolveDatabaseTarget(env({ DATABASE_URL: 'redis://db:6379' }))).toThrow(
        /"redis"/,
      );
    });

    it('requires something to be set at all, and names both ways of doing it', () => {
      expect(() => resolveDatabaseTarget(env({}))).toThrow(/No database is configured/);
      expect(() => resolveDatabaseTarget(env({}))).toThrow(/POSTGRES_PASSWORD/);
      expect(() => resolveDatabaseTarget(env({}))).toThrow(/DATABASE_URL/);
      // What `${DATABASE_URL:-}` in the compose file produces when unset.
      expect(() => resolveDatabaseTarget(env({ DATABASE_URL: '   ' }))).toThrow(
        /No database is configured/,
      );
    });
  });
});

/** driverOptions takes only a PostgreSQL target; these are, and the narrowing says so. */
function postgres(target: ReturnType<typeof resolveDatabaseTarget>) {
  if (target.kind === 'sqlite') throw new Error('expected a PostgreSQL target');
  return target;
}

describe('driverOptions', () => {
  it('hands the fields to the driver as fields, with nothing of ours left in', () => {
    const options = driverOptions(
      postgres(resolveDatabaseTarget(env({ POSTGRES_PASSWORD: 'pa/ss' }))),
    );
    expect(options).toEqual({
      hostname: 'postgres',
      port: 5432,
      username: 'cpm',
      password: 'pa/ss',
      database: 'cpm',
      tls: false,
    });
    expect(options).not.toHaveProperty('kind');
  });

  it('hands a URL over as a url', () => {
    const options = driverOptions(
      postgres(resolveDatabaseTarget(env({ DATABASE_URL: 'postgres://db/cpm' }))),
    );
    expect(options).toEqual({ url: 'postgres://db/cpm' });
  });
});
