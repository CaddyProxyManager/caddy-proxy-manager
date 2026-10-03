/**
 * Keys composed at runtime, which TypeScript cannot check. The English must match the registry's
 * copy, which `/api/v1/caddy/modules` still returns.
 */
import { describe, expect, it } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';
import { CADDY_MODULES } from '@/src/lib/caddy-modules';
import {
  type ModuleConflict,
  englishModuleConflict,
  englishModuleConflicts,
} from '@/src/lib/caddy-build-conflicts';
import {
  caddyModuleDescription,
  caddyModuleMessageName,
  caddyModuleName,
  moduleConflictMessage,
} from '@/src/lib/caddy-module-messages';

const t = createTranslator({ locale: 'en', messages });

/** One of every kind, with the counts that pick each plural branch. */
const CONFLICTS: ModuleConflict[] = [
  { kind: 'l4Hosts', count: 1 },
  { kind: 'l4Hosts', count: 3 },
  { kind: 'globalWaf' },
  { kind: 'globalGeoblock' },
  { kind: 'globalCrowdsec' },
  { kind: 'hostWaf', count: 1 },
  { kind: 'hostWaf', count: 2 },
  { kind: 'hostGeoblock', count: 1 },
  { kind: 'hostGeoblock', count: 4 },
  { kind: 'tailnetHosts', count: 1 },
  { kind: 'tailnetHosts', count: 5 },
  { kind: 'defaultDnsProvider', provider: 'cloudflare' },
  { kind: 'dnsProviderCredentials', provider: 'route53' },
];

describe('caddyModules messages', () => {
  it('names every module as the registry does', () => {
    const mismatches = CADDY_MODULES.filter(
      (module) => caddyModuleName(t, module) !== module.name,
    ).map((module) => module.id);
    expect(mismatches).toEqual([]);
  });

  it('describes every module as the registry does', () => {
    const mismatches = CADDY_MODULES.filter(
      (module) => caddyModuleDescription(t, module) !== module.description,
    ).map((module) => module.id);
    expect(mismatches).toEqual([]);
  });

  it('has no entry for a built-in module that no longer exists', () => {
    const known = new Set(
      CADDY_MODULES.filter((module) => module.dnsProvider === undefined).map((module) =>
        caddyModuleMessageName(module.id),
      ),
    );
    expect(Object.keys(messages.caddyModules.modules).filter((name) => !known.has(name))).toEqual(
      [],
    );
  });

  it('words every module conflict as /api/v1 does', () => {
    const mismatches = CONFLICTS.filter(
      (conflict) => moduleConflictMessage(t, [conflict]) !== englishModuleConflicts([conflict]),
    ).map(englishModuleConflict);
    expect(mismatches).toEqual([]);
  });

  it('joins several conflicts into one refusal as /api/v1 does', () => {
    expect(moduleConflictMessage(t, CONFLICTS)).toBe(englishModuleConflicts(CONFLICTS));
    expect(moduleConflictMessage(t, [])).toBeNull();
  });
});
