import { describe, expect, it } from 'bun:test';
import { readResponseFacts } from '@/src/lib/auth/saml/response-checks';
import {
  buildAssertion,
  createTestIdp,
  encodeResponse,
  sign,
  signedResponse,
  wrapInResponse,
} from '@/tests/helpers/saml-idp';

const idp = createTestIdp();
const SKEW = 120_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const options = {
  inResponseTo: '_req',
  destination: 'https://cpm.example.com/acs',
  audience: 'sp',
};

describe('readResponseFacts', () => {
  it('reads the sole assertion and remembers it until it lapses, plus the skew', () => {
    const xml = signedResponse(idp, {
      ...options,
      assertionId: '_one',
      notOnOrAfter: new Date(NOW + 5 * 60_000),
    });
    expect(readResponseFacts(encodeResponse(xml), SKEW, NOW)).toEqual({
      strongAlgorithms: true,
      assertionId: '_one',
      rememberUntil: NOW + 5 * 60_000 + SKEW,
    });
  });

  it('flags SHA-1 in a signature or a digest', () => {
    const xml = signedResponse(idp, options, { algorithm: 'sha1' });
    expect(readResponseFacts(encodeResponse(xml), SKEW, NOW)?.strongAlgorithms).toBe(false);
  });

  it('accepts an unsigned response as far as algorithms go: the plugin refuses it', () => {
    const xml = wrapInResponse(idp, options, buildAssertion(idp, options));
    expect(readResponseFacts(encodeResponse(xml), SKEW, NOW)?.strongAlgorithms).toBe(true);
  });

  it('names no assertion when there are several, which the plugin refuses itself', () => {
    const one = sign(buildAssertion(idp, { ...options, assertionId: '_a' }), {
      key: idp.key,
      target: 'Assertion',
    });
    const xml = wrapInResponse(
      idp,
      options,
      one + buildAssertion(idp, { ...options, assertionId: '_b' }),
    );
    expect(readResponseFacts(encodeResponse(xml), SKEW, NOW)?.assertionId).toBeNull();
  });

  it('caps how long an assertion is remembered, and remembers one with no end for an hour', () => {
    const far = signedResponse(idp, { ...options, notOnOrAfter: new Date(NOW + 30 * 86_400_000) });
    expect(readResponseFacts(encodeResponse(far), SKEW, NOW)?.rememberUntil).toBe(NOW + 86_400_000);
    const endless = signedResponse(idp, { ...options, notOnOrAfter: null });
    expect(readResponseFacts(encodeResponse(endless), SKEW, NOW)?.rememberUntil).toBe(
      NOW + 3_600_000,
    );
    const lapsed = signedResponse(idp, { ...options, notOnOrAfter: new Date(NOW - 86_400_000) });
    expect(readResponseFacts(encodeResponse(lapsed), SKEW, NOW)?.rememberUntil).toBe(NOW + SKEW);
  });

  it('gives up on what is not XML, leaving the refusal to the plugin', () => {
    expect(readResponseFacts(undefined, SKEW, NOW)).toBeNull();
    expect(readResponseFacts('', SKEW, NOW)).toBeNull();
    expect(readResponseFacts(encodeResponse('plain text'), SKEW, NOW)).toBeNull();
    expect(readResponseFacts(encodeResponse('<a><b></a>'), SKEW, NOW)).toBeNull();
  });
});
