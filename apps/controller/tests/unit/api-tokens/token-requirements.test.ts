/**
 * A narrowed token is refused anything not named in lib/api-tokens/requirements.ts. These keep the
 * map whole: a new resolver or REST route fails here until it is given an area.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildSchema } from 'graphql';
import { typeDefs } from '../../../src/lib/graphql/typedefs';
import {
  GRAPHQL_REQUIREMENTS,
  restRequirement,
  tokenAllows,
} from '../../../src/lib/api-tokens/requirements';

const schema = buildSchema(typeDefs);

/** The agent's own fields, signed by the agent and never reached with a token. */
const AGENT_FIELDS = new Set([
  'agentStatus',
  'agentCommandResults',
  'agentAnalytics',
  'agentCertificateFiles',
]);

function fieldsOf(type: 'Query' | 'Mutation'): string[] {
  const object = type === 'Query' ? schema.getQueryType() : schema.getMutationType();
  return Object.keys(object?.getFields() ?? {}).filter((name) => !AGENT_FIELDS.has(name));
}

function keys(): string[] {
  return [
    ...fieldsOf('Query').map((name) => `Query.${name}`),
    ...fieldsOf('Mutation').map((name) => `Mutation.${name}`),
  ];
}

describe('GraphQL requirements', () => {
  it('name every query and mutation a token can reach', () => {
    expect(keys().filter((key) => !(key in GRAPHQL_REQUIREMENTS))).toEqual([]);
  });

  it('name nothing that is not in the schema', () => {
    const known = new Set(keys());
    expect(Object.keys(GRAPHQL_REQUIREMENTS).filter((key) => !known.has(key))).toEqual([]);
  });

  it('make every mutation a write, so a read-only token can make none', () => {
    for (const name of fieldsOf('Mutation')) {
      const requirement = GRAPHQL_REQUIREMENTS[`Mutation.${name}`] ?? null;
      expect({ name, access: requirement?.access }).toEqual({ name, access: 'write' });
      expect(tokenAllows({ kind: 'read' }, requirement)).toBe(false);
    }
  });

  it('cover the writes earlier releases added', () => {
    for (const name of [
      'exportConfig',
      'previewConfigImport',
      'applyConfigImport',
      'verifyAuditChain',
      'createBlockedSource',
      'reviewWafEvent',
      'setSetupStepDone',
      'createAnalyticsView',
      'bulkProxyHosts',
      'previewProxyHost',
      'setAccessListRules',
    ]) {
      expect(GRAPHQL_REQUIREMENTS[`Mutation.${name}`]?.access).toBe('write');
    }
  });
});

const API_ROOT = join(import.meta.dir, '../../../src/app/api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === 'route.ts' ? [path] : [];
  });
}

describe('REST requirements', () => {
  // Only routes that accept a Bearer token; the rest never see one.
  const tokenRoutes = routeFiles(API_ROOT).filter((file) =>
    /requireApi(User|Admin)\(/.test(readFileSync(file, 'utf8')),
  );

  it('find the routes', () => {
    expect(tokenRoutes.length).toBeGreaterThan(50);
  });

  it('give every route that takes a token an area, for each method it exports', () => {
    const missing: string[] = [];
    for (const file of tokenRoutes) {
      const segments = relative(API_ROOT, file).split(sep).slice(0, -1);
      const path = `/api/${segments.map((part) => (part.startsWith('[') ? '1' : part)).join('/')}`;
      const methods = [
        ...readFileSync(file, 'utf8').matchAll(
          /export async function (GET|POST|PUT|PATCH|DELETE)/g,
        ),
      ].map((match) => match[1]);
      for (const method of methods) {
        if (restRequirement(path, method) === null) missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('read on GET and write otherwise, a backup download included', () => {
    expect(restRequirement('/api/v1/proxy-hosts/3', 'GET')).toEqual({
      area: 'hosts',
      access: 'read',
    });
    expect(restRequirement('/api/v1/proxy-hosts/preview', 'POST')).toEqual({
      area: 'hosts',
      access: 'write',
    });
    expect(restRequirement('/api/v1/backup', 'GET')).toMatchObject({ access: 'write' });
    expect(restRequirement('/api/v1/proxy-hostsx', 'GET')).toBeNull();
    expect(restRequirement('/api/v1/openapi.json', 'GET')).toBe('any');
  });

  it('keep the backup and config transfer from any token short of full', () => {
    const settingsWrite = {
      kind: 'custom' as const,
      permissions: ['settings:write' as const, 'users:write' as const],
    };
    for (const requirement of [
      restRequirement('/api/v1/backup', 'GET'),
      restRequirement('/api/v1/backup', 'POST'),
      GRAPHQL_REQUIREMENTS['Mutation.exportConfig'],
      GRAPHQL_REQUIREMENTS['Mutation.previewConfigImport'],
      GRAPHQL_REQUIREMENTS['Mutation.applyConfigImport'],
    ]) {
      expect(tokenAllows(settingsWrite, requirement ?? null)).toBe(false);
      expect(tokenAllows({ kind: 'full' }, requirement ?? null)).toBe(true);
      expect(tokenAllows(undefined, requirement ?? null)).toBe(true);
    }
    expect(tokenAllows(settingsWrite, restRequirement('/api/v1/settings', 'PUT'))).toBe(true);
  });

  it('let a session and a full token through, and refuse an unnamed path to a narrowed one', () => {
    expect(tokenAllows(undefined, null)).toBe(true);
    expect(tokenAllows({ kind: 'full' }, null)).toBe(true);
    expect(tokenAllows({ kind: 'read' }, null)).toBe(false);
  });
});
