/**
 * What CPM's SAML consumer refuses, proven against responses signed with a test key rather than
 * read from the plugin's docs, which say nothing about audience, recipient or signature wrapping.
 * Every refusal must leave the browser without a session and the database without a user.
 */
import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { vi } from '@/tests/helpers/vi';
import { CookieJar, bootSaml, outcome, registerSamlCleanup } from '@/tests/helpers/saml-harness';
import {
  buildAssertion,
  createTestKey,
  sign,
  signedResponse,
  wrapInResponse,
} from '@/tests/helpers/saml-idp';

vi.mock('next-intl/server', () => nextIntlServerMock());
registerSamlCleanup();

const REGISTRATION = { env: { AUTH_ALLOW_OAUTH_REGISTRATION: 'true' } };
const MINUTE = 60_000;

type Harness = Awaited<ReturnType<typeof bootSaml>>;

async function usersNamed(h: Harness, email = 'saml.user@example.com') {
  return h.db.select().from(h.schema.users).where(eq(h.schema.users.email, email));
}

async function expectRefused(h: Harness, jar: CookieJar, response: Response) {
  const result = outcome(response);
  expect(result.status).toBe(302);
  expect(result.error).not.toBeNull();
  expect(jar.has('session_token')).toBe(false);
  expect(await usersNamed(h)).toHaveLength(0);
  return result;
}

/** Starts a sign-in and posts `xml(requestId)` back with its RelayState. */
async function answer(h: Harness, xml: (requestId: string) => string) {
  const { jar, request } = await h.start();
  if (!request) throw new Error('No AuthnRequest');
  const response = await h.post(jar, xml(request.id), request.relayState);
  return { jar, response };
}

describe('a SAML response CPM accepts', () => {
  it('signs in with a signed assertion, creating the account', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await h.signIn();
    const result = outcome(response);
    expect(result.status).toBe(302);
    expect(result.error).toBeNull();
    expect(result.location).toBe('/');
    expect(jar.has('session_token')).toBe(true);
    const [user] = await usersNamed(h);
    expect(user).toMatchObject({ name: 'Saml User', role: 'user', status: 'active' });
    // Single sign-on to the users list, whichever protocol.
    expect(user.lastSignInMethod).toBe('oidc');
  });

  it('allows two minutes of clock skew either way', async () => {
    const h = await bootSaml(REGISTRATION);
    const expiredWithinSkew = await h.signIn({
      notOnOrAfter: new Date(Date.now() - MINUTE),
    });
    expect(outcome(expiredWithinSkew.response).error).toBeNull();
    const earlyWithinSkew = await h.signIn({
      notBefore: new Date(Date.now() + MINUTE),
      assertionId: '_early-within-skew',
    });
    expect(outcome(earlyWithinSkew.response).error).toBeNull();
  });
});

describe('a SAML response CPM refuses', () => {
  it('refuses an assertion with no signature at all', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      wrapInResponse(h.idp, h.responseFor(id), buildAssertion(h.idp, h.responseFor(id))),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an unsigned assertion inside a signed response', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      sign(wrapInResponse(h.idp, h.responseFor(id), buildAssertion(h.idp, h.responseFor(id))), {
        key: h.idp.key,
        target: 'Response',
      }),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an assertion signed with another key', async () => {
    const h = await bootSaml(REGISTRATION);
    const stranger = createTestKey('stranger.test');
    const { jar, response } = await answer(h, (id) =>
      signedResponse(h.idp, h.responseFor(id), { key: stranger }),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an assertion meant for another service provider', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      signedResponse(h.idp, h.responseFor(id, { audience: 'https://other-app.example.com/saml' })),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an assertion with no audience restriction', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      signedResponse(h.idp, h.responseFor(id, { audience: null })),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an assertion addressed to another recipient', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      signedResponse(
        h.idp,
        h.responseFor(id, { recipient: 'https://other-app.example.com/saml/acs' }),
      ),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an expired assertion beyond the two-minute skew', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      signedResponse(
        h.idp,
        h.responseFor(id, {
          notBefore: new Date(Date.now() - 10 * MINUTE),
          notOnOrAfter: new Date(Date.now() - 3 * MINUTE),
        }),
      ),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an assertion not yet valid beyond the two-minute skew', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      signedResponse(h.idp, h.responseFor(id, { notBefore: new Date(Date.now() + 3 * MINUTE) })),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an assertion without timestamps', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      signedResponse(h.idp, h.responseFor(id, { notBefore: null, notOnOrAfter: null })),
    );
    await expectRefused(h, jar, response);
  });

  it('refuses an assertion signed with a deprecated algorithm', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, response } = await answer(h, (id) =>
      signedResponse(h.idp, h.responseFor(id), { algorithm: 'sha1' }),
    );
    // CPM's own check: the plugin only sees a redirect-bound signature's algorithm.
    expect((await expectRefused(h, jar, response)).error).toBe('deprecated_algorithm');
  });

  it('refuses a response the identity provider started (no AuthnRequest behind it)', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar } = await h.start();
    const response = await h.post(jar, signedResponse(h.idp, h.responseFor(null)), null);
    const result = await expectRefused(h, jar, response);
    expect(result.error).toBe('unsolicited_response');
  });

  it('refuses a response to an AuthnRequest it never sent', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, request } = await h.start();
    const response = await h.post(
      jar,
      signedResponse(h.idp, h.responseFor('_never-sent')),
      request?.relayState ?? null,
    );
    await expectRefused(h, jar, response);
  });

  it('refuses the same response posted twice', async () => {
    const h = await bootSaml(REGISTRATION);
    const { jar, request } = await h.start();
    if (!request) throw new Error('No AuthnRequest');
    const xml = signedResponse(h.idp, h.responseFor(request.id));
    expect(outcome(await h.post(jar, xml, request.relayState)).error).toBeNull();

    const attacker = new CookieJar();
    const replay = await h.post(attacker, xml, request.relayState);
    expect(outcome(replay).error).toBe('replay_detected');
    expect(attacker.has('session_token')).toBe(false);
  });

  it('refuses a captured assertion replayed inside a fresh response', async () => {
    const h = await bootSaml(REGISTRATION);
    const first = await h.start();
    if (!first.request) throw new Error('No AuthnRequest');
    const assertion = sign(buildAssertion(h.idp, h.responseFor(first.request.id)), {
      key: h.idp.key,
      target: 'Assertion',
    });
    const accepted = await h.post(
      first.jar,
      wrapInResponse(h.idp, h.responseFor(first.request.id), assertion),
      first.request.relayState,
    );
    expect(outcome(accepted).error).toBeNull();

    // The Response element is unsigned, so an attacker can point it at a sign-in of their own.
    const second = await h.start();
    if (!second.request) throw new Error('No AuthnRequest');
    const replay = await h.post(
      second.jar,
      wrapInResponse(h.idp, h.responseFor(second.request.id), assertion),
      second.request.relayState,
    );
    // CPM's own marker: the plugin's needs a string primary key that serial ids never collide on.
    expect(outcome(replay).error).toBe('replay_detected');
    expect(second.jar.has('session_token')).toBe(false);
  });

  describe('signature wrapping', () => {
    const evil = (h: Harness, id: string) =>
      buildAssertion(
        h.idp,
        h.responseFor(id, {
          nameId: 'attacker',
          attributes: { email: 'saml.user@example.com', displayName: 'Attacker' },
          assertionId: '_evil',
        }),
      );
    const genuine = (h: Harness, id: string) =>
      sign(
        buildAssertion(
          h.idp,
          h.responseFor(id, {
            nameId: 'victim',
            attributes: { email: 'victim@example.com' },
            assertionId: '_genuine',
          }),
        ),
        { key: h.idp.key, target: 'Assertion' },
      );

    it('refuses a signed assertion moved beside an unsigned one', async () => {
      const h = await bootSaml(REGISTRATION);
      for (const order of ['evil-first', 'genuine-first'] as const) {
        const { jar, response } = await answer(h, (id) =>
          wrapInResponse(
            h.idp,
            h.responseFor(id),
            order === 'evil-first' ? evil(h, id) + genuine(h, id) : genuine(h, id) + evil(h, id),
          ),
        );
        await expectRefused(h, jar, response);
      }
    });

    it('refuses an unsigned assertion carrying the signed one inside it', async () => {
      const h = await bootSaml(REGISTRATION);
      const { jar, response } = await answer(h, (id) => {
        const outer = evil(h, id).replace(
          '<saml:AttributeStatement>',
          `<saml:Advice>${genuine(h, id)}</saml:Advice><saml:AttributeStatement>`,
        );
        return wrapInResponse(h.idp, h.responseFor(id), outer);
      });
      await expectRefused(h, jar, response);
    });

    it("refuses an unsigned assertion borrowing the signed one's signature", async () => {
      const h = await bootSaml(REGISTRATION);
      const { jar, response } = await answer(h, (id) => {
        const signed = genuine(h, id);
        const signature = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signed)?.[0] ?? '';
        const forged = evil(h, id).replace('</saml:Issuer>', `</saml:Issuer>${signature}`);
        // The genuine assertion parked where a lax verifier might still find it by ID.
        const response = wrapInResponse(h.idp, h.responseFor(id), forged);
        return response.replace(
          '<samlp:Status>',
          `<samlp:Extensions>${signed}</samlp:Extensions><samlp:Status>`,
        );
      });
      await expectRefused(h, jar, response);
    });

    it('refuses a signed assertion edited after signing', async () => {
      const h = await bootSaml(REGISTRATION);
      const { jar, response } = await answer(h, (id) =>
        signedResponse(h.idp, h.responseFor(id)).replace('Saml User', 'Administrator'),
      );
      await expectRefused(h, jar, response);
    });
  });
});
