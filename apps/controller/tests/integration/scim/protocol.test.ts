/**
 * The protocol's shape, case by case as a SCIM conformance suite checks it: media type, list
 * responses, meta, uniqueness, scimType errors, filters, paging and discovery.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { testDialect } from '@/tests/helpers/db';
import {
  GROUP_SCHEMA,
  USER_SCHEMA,
  bootScim,
  registerScimCleanup,
} from '@/tests/helpers/scim-harness';

registerScimCleanup();
// Each test boots Better Auth on a fresh database, which a loaded parallel run makes slow.
setDefaultTimeout(30_000);

const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

describe.skipIf(testDialect === 'sqlite')('SCIM protocol shape', () => {
  it('answers application/scim+json with meta on every resource', async () => {
    const h = await bootScim();
    const created = await h.createUser('meta@example.com', { externalId: 'ext-meta' });
    expect(created.status).toBe(201);
    expect(created.contentType).toContain('application/scim+json');
    expect(created.location).toBe(created.body.meta.location);
    expect(created.body.schemas).toEqual([USER_SCHEMA]);
    expect(created.body.meta).toMatchObject({
      resourceType: 'User',
      location: `http://localhost:3000/api/auth/scim/v2/Users/${created.body.id}`,
    });
    expect(created.body.meta.version).toMatch(/^W\/"\d+"$/);

    const fetched = await h.call('GET', `/Users/${created.body.id}`);
    expect(fetched.contentType).toContain('application/scim+json');
    expect(fetched.body.meta.version).toMatch(/^W\/"\d+"$/);

    const group = await h.createGroup('Meta group');
    expect(group.body.meta).toMatchObject({ resourceType: 'Group' });
    expect(group.body.meta.version).toMatch(/^W\/"\d+"$/);
    expect(group.body.schemas).toEqual([GROUP_SCHEMA]);
  });

  it('lists with totalResults, itemsPerPage and startIndex, paged', async () => {
    const h = await bootScim();
    for (const name of ['p1', 'p2', 'p3']) await h.createUser(`${name}@example.com`);
    const all = await h.call('GET', '/Users');
    expect(all.body).toMatchObject({
      schemas: [LIST],
      totalResults: 3,
      itemsPerPage: 3,
      startIndex: 1,
    });
    expect(all.body.Resources).toHaveLength(3);
    for (const resource of all.body.Resources) expect(resource.meta.version).toMatch(/^W\//);

    const page = await h.call('GET', '/Users?startIndex=2&count=1');
    expect(page.body).toMatchObject({ totalResults: 3, itemsPerPage: 1, startIndex: 2 });
    expect(page.body.Resources[0].userName).toBe(all.body.Resources[1].userName);

    const past = await h.call('GET', '/Users?startIndex=10&count=5');
    expect(past.body).toMatchObject({ totalResults: 3, itemsPerPage: 0 });
  });

  it('filters by userName eq and externalId eq, alone or joined by and', async () => {
    const h = await bootScim();
    await h.createUser('filter.a@example.com', { externalId: 'fa' });
    await h.createUser('filter.b@example.com', { externalId: 'fb' });
    const byName = await h.call(
      'GET',
      `/Users?filter=${encodeURIComponent('userName eq "FILTER.A@example.com"')}`,
    );
    expect(byName.body.totalResults).toBe(1);
    expect(byName.body.Resources[0].externalId).toBe('fa');
    const byExternal = await h.call(
      'GET',
      `/Users?filter=${encodeURIComponent('externalId eq "fb"')}`,
    );
    expect(byExternal.body.Resources.map((r: { userName: string }) => r.userName)).toEqual([
      'filter.b@example.com',
    ]);
    const both = await h.call(
      'GET',
      `/Users?filter=${encodeURIComponent('userName eq "filter.a@example.com" and externalId eq "fb"')}`,
    );
    expect(both.body.totalResults).toBe(0);
  });

  it('refuses every filter it does not answer as invalidFilter', async () => {
    const h = await bootScim();
    for (const filter of [
      'userName co "a"',
      'userName sw "a"',
      'userName pr',
      'userName eq "a" or userName eq "b"',
      'not (userName eq "a")',
      'emails[type eq "work"]',
      'nickName eq "a"',
    ]) {
      const answer = await h.call('GET', `/Users?filter=${encodeURIComponent(filter)}`);
      expect({ filter, status: answer.status, scimType: answer.body.scimType }).toEqual({
        filter,
        status: 400,
        scimType: 'invalidFilter',
      });
      expect(answer.body.schemas).toEqual([ERROR]);
    }
  });

  it('answers 409 uniqueness for a userName already provisioned, in any case', async () => {
    const h = await bootScim();
    await h.createUser('unique@example.com');
    for (const userName of ['unique@example.com', 'UNIQUE@example.com']) {
      const again = await h.createUser(userName);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ schemas: [ERROR], status: '409', scimType: 'uniqueness' });
    }
  });

  it('answers each 400 with its scimType', async () => {
    const h = await bootScim();
    const user = await h.createUser('errors@example.com');
    const path = `/Users/${user.body.id}`;
    const cases: Array<[unknown[], string]> = [
      [[{ op: 'replace', path: 'nickname[', value: 'x' }], 'invalidPath'],
      [[{ op: 'replace', path: 'noSuchAttribute', value: 'x' }], 'invalidPath'],
      [[{ op: 'remove' }], 'noTarget'],
      [[{ op: 'replace', path: 'id', value: 'other' }], 'mutability'],
      [[{ op: 'replace', path: 'active', value: 'maybe' }], 'invalidValue'],
    ];
    for (const [ops, scimType] of cases) {
      const answer = await h.patch(path, ops);
      expect({ ops, status: answer.status, scimType: answer.body.scimType }).toEqual({
        ops,
        status: 400,
        scimType,
      });
    }
  });

  it('describes itself truthfully', async () => {
    const h = await bootScim();
    const config = await h.call('GET', '/ServiceProviderConfig');
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      changePassword: { supported: false },
      filter: { supported: true },
    });
    expect(config.body.filter.maxResults).toBeGreaterThan(0);
    expect(config.body.authenticationSchemes[0].type).toBe('oauthbearertoken');

    const types = await h.call('GET', '/ResourceTypes');
    expect(types.body.Resources.map((r: { id: string }) => r.id).sort()).toEqual(['Group', 'User']);
    expect((await h.call('GET', '/ResourceTypes/User')).body.endpoint).toBe('/Users');

    const schemas = await h.call('GET', '/Schemas');
    const ids = schemas.body.Resources.map((r: { id: string }) => r.id);
    expect(ids).toContain(USER_SCHEMA);
    expect(ids).toContain(GROUP_SCHEMA);
    expect((await h.call('GET', `/Schemas/${USER_SCHEMA}`)).status).toBe(200);
  });

  it('answers 501 for what it does not support', async () => {
    const h = await bootScim();
    for (const [method, path] of [
      ['GET', '/Me'],
      ['POST', '/Bulk'],
    ]) {
      const answer = await h.call(method, path, method === 'POST' ? {} : undefined);
      expect(answer.status).toBe(501);
      expect(answer.body.schemas).toEqual([ERROR]);
    }
  });

  it('selects attributes', async () => {
    const h = await bootScim();
    const user = await h.createUser('select@example.com');
    const only = await h.call('GET', `/Users/${user.body.id}?attributes=userName`);
    expect(only.body.userName).toBe('select@example.com');
    expect(only.body.id).toBe(user.body.id);
    expect(only.body.emails).toBeUndefined();
    const without = await h.call('GET', `/Users/${user.body.id}?excludedAttributes=emails`);
    expect(without.body.emails).toBeUndefined();
    expect(without.body.userName).toBe('select@example.com');
  });
});
