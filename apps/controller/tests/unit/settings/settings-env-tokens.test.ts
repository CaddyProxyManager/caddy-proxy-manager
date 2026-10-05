import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

/**
 * Env-var tokens on the settings screens (and in its search) must name a variable `.env.example`
 * documents, or they send an operator hunting for a line that isn't there. Not the reverse: most
 * variables have no settings page.
 */

const settingsClient = readFileSync(
  join(process.cwd(), 'src/app/(dashboard)/settings/sections.ts'),
  'utf8',
);

const settingsBlocks = readFileSync(
  join(process.cwd(), 'src/app/(dashboard)/settings/SettingsClient.tsx'),
  'utf8',
);

const envExample = readFileSync(join(process.cwd(), '../../.env.example'), 'utf8');

/** Commented-out lines included: those are documentation too. */
const documented = new Set(
  Array.from(envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm), (m) => m[1]),
);

/** Not CPM's own: Caddy resolves `{env.TS_AUTHKEY}`, keeping the key out of the database. */
const FOREIGN = new Set(['TS_AUTHKEY']);

/** A family rather than a variable; members are asserted separately. */
const isWildcard = (name: string) => name.endsWith('_*');

function tokensIn(field: 'env' | 'envSearch'): string[] {
  const names: string[] = [];
  for (const block of settingsClient.matchAll(
    new RegExp(String.raw`\b${field}:\s*\[([^\]]*)\]`, 'g'),
  )) {
    for (const quoted of block[1].matchAll(/"([^"]+)"/g)) names.push(quoted[1]);
  }
  return names;
}

/** As `<EnvLabelledField env={[...]}>`. */
function fieldTokens(): string[] {
  const names: string[] = [];
  for (const use of settingsBlocks.matchAll(/<EnvLabelledField[^>]*?env=\{\[([^\]]*)\]\}/g)) {
    for (const quoted of use[1].matchAll(/"([^"]+)"/g)) names.push(quoted[1]);
  }
  return names;
}

describe('settings environment tokens', () => {
  it('finds tokens to check', () => {
    // A refactor renaming the fields would otherwise leave this asserting nothing, quietly.
    expect([...tokensIn('env'), ...fieldTokens()].length).toBeGreaterThan(15);
    expect(tokensIn('envSearch').length).toBeGreaterThan(0);
    // Both shapes are in use; dropping one fails here rather than going quiet.
    expect(tokensIn('env').length).toBeGreaterThan(0);
    expect(fieldTokens().length).toBeGreaterThan(0);
  });

  it('names only variables the deployment documents', () => {
    const unknown = [...tokensIn('env'), ...tokensIn('envSearch'), ...fieldTokens()]
      .filter((name) => !isWildcard(name))
      .filter((name) => !documented.has(name) && !FOREIGN.has(name));

    expect(unknown).toEqual([]);
  });

  it('names only documented variables on the setup step', () => {
    // The identity-provider card is not registry-generated.
    const setupClient = readFileSync(
      join(process.cwd(), 'src/app/setup/settings/SetupSettingsClient.tsx'),
      'utf8',
    );
    const names = Array.from(setupClient.matchAll(/"(OAUTH_[A-Z_]+)"/g), (m) => m[1]);

    expect(names.length).toBeGreaterThan(15);
    expect(names.filter((name) => !documented.has(name))).toEqual([]);
  });

  it('shows a variable in one place, not two', () => {
    // Named twice, it reads as two different settings.
    const heading = new Set(tokensIn('env'));
    expect(fieldTokens().filter((name) => heading.has(name))).toEqual([]);
  });

  it('backs every wildcard token with the members it stands for', () => {
    const searchable = new Set(tokensIn('envSearch'));

    for (const wildcard of tokensIn('env').filter(isWildcard)) {
      const prefix = wildcard.slice(0, -1);
      const members = [...searchable].filter((name) => name.startsWith(prefix));

      // Shown as a prefix, so only the search reaches it by a member's name.
      expect(members.length).toBeGreaterThan(0);
    }
  });
});
