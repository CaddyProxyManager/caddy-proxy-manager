/**
 * Regression (H1): the probe HMACed any nonce under SESSION_SECRET, and the forward-auth proxy
 * proof was that HMAC over a constant, so `?probe=cpm-forward-auth-proxy-proof:v1` leaked it.
 */
import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { GET as health } from '@/src/app/api/health/route';
import { config } from '@/src/lib/config';
import {
  FORWARD_AUTH_PROXY_PROOF_HEADER,
  getForwardAuthProxyProof,
  getTrustedForwardAuthOrigin,
} from '@/src/lib/forward-auth/trust';
import { signProbe } from '@/src/lib/reachability/probe';

async function probe(nonce: string): Promise<string | undefined> {
  const response = await health(
    new Request(`http://localhost:3000/api/health?probe=${encodeURIComponent(nonce)}`),
  );
  return ((await response.json()) as { probe?: string }).probe;
}

function originWithProof(proof: string): string | null {
  return getTrustedForwardAuthOrigin(
    new Headers({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'app.example.com',
      [FORWARD_AUTH_PROXY_PROOF_HEADER]: proof,
    }),
  );
}

describe('probe and forward-auth proof keys', () => {
  it('never answers a probe with the proxy proof, whatever the context string', async () => {
    const proof = getForwardAuthProxyProof();
    for (const nonce of ['cpm-forward-auth-proxy-proof:v1', 'cpm-forward-auth-proxy-proof:v2']) {
      const answer = await probe(nonce);
      expect(answer).toBe(signProbe(nonce));
      expect(answer).not.toBe(proof);
      expect(originWithProof(answer ?? '')).toBeNull();
    }
  });

  it('signs probes under a derived key rather than the raw session secret', () => {
    const nonce = 'abc123';
    expect(signProbe(nonce)).not.toBe(
      createHmac('sha256', config.sessionSecret).update(nonce).digest('hex'),
    );
  });

  it('rejects the v1 proof an attacker could have harvested before the fix', () => {
    const legacy = createHmac('sha256', config.sessionSecret)
      .update('cpm-forward-auth-proxy-proof:v1')
      .digest('hex');
    expect(originWithProof(legacy)).toBeNull();
    expect(originWithProof(getForwardAuthProxyProof())).toBe('https://app.example.com');
  });
});
