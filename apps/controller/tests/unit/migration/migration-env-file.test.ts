/**
 * The app never sees `.env`, so this pins the advice: what to comment out, what to leave, and that
 * the command it hands over matches the first list only.
 */
import { describe, expect, it } from 'bun:test';
import { planEnvCleanup } from '@/src/lib/migration/env-file';

describe('planEnvCleanup', () => {
  it('offers to comment out a migrated variable', () => {
    const { comment, keep, command } = planEnvCleanup(['APP_NAME']);

    expect(comment).toEqual(['APP_NAME']);
    expect(keep).toEqual([]);
    expect(command).toContain('APP_NAME');
  });

  it('holds back the variables Compose reads', () => {
    const { comment, keep, command } = planEnvCleanup([
      'APP_NAME',
      'CLICKHOUSE_PASSWORD',
      'GEOIPUPDATE_LICENSE_KEY',
    ]);

    // Compose provisions clickhouse from it and cannot read the database; the MaxMind key can go.
    expect(keep).toEqual(['CLICKHOUSE_PASSWORD']);
    expect(comment).toEqual(['APP_NAME', 'GEOIPUPDATE_LICENSE_KEY']);
    expect(command).not.toContain('CLICKHOUSE_PASSWORD');
    expect(command).toContain('GEOIPUPDATE_LICENSE_KEY');
  });

  it('ignores a name that is not a setting', () => {
    // Read before the database can be, so never in the registry or the command.
    const { comment, command } = planEnvCleanup(['SESSION_SECRET', 'DATABASE_URL', 'APP_NAME']);

    expect(comment).toEqual(['APP_NAME']);
    expect(command).not.toContain('SESSION_SECRET');
    expect(command).not.toContain('DATABASE_URL');
  });

  it('has no command when nothing can be removed', () => {
    expect(planEnvCleanup([]).command).toBeNull();
    expect(planEnvCleanup(['CLICKHOUSE_PASSWORD']).command).toBeNull();
  });

  it('edits .env in place, keeping a backup, and comments rather than deletes', () => {
    const command = planEnvCleanup(['APP_NAME', 'BASE_URL']).command ?? '';

    // `-i.bak` with the suffix attached is the one spelling both GNU and BSD sed accept.
    expect(command).toContain('sed -i.bak -E');
    expect(command).toContain('.env');
    expect(command).toContain('# migrated to the database:');
    expect(command).toContain("migrated='APP_NAME|BASE_URL'");
    // A live `${migrated}` for the shell. The builder's `\${` is a JS escape, not a shell one -
    // pinned because a reviewer has already misread it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is the assertion
    expect(command).toContain('(${migrated})');
    expect(command).not.toContain('\\${');
  });

  it('lists variables in the order the settings pages use', () => {
    const forwards = planEnvCleanup(['APP_NAME', 'LOGIN_MAX_ATTEMPTS']).comment;
    const backwards = planEnvCleanup(['LOGIN_MAX_ATTEMPTS', 'APP_NAME']).comment;

    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual(['APP_NAME', 'LOGIN_MAX_ATTEMPTS']);
  });
});
