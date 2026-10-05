/**
 * Which certificate a host serves, how long it has, and when that is trouble: an imported one by
 * days alone, a managed one only once it is past the point Caddy should have renewed it.
 */
import { describe, expect, it } from 'bun:test';
import {
  type CertificateExpiry,
  certificateStage,
  daysLeft,
  hostCertificate,
  managedExpiry,
} from '@/src/lib/certificates/expiry';

const DAY = 86_400_000;
const NOW = Date.parse('2026-03-01T00:00:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

function cert(overrides: Partial<CertificateExpiry>): CertificateExpiry {
  return {
    certificateId: null,
    name: 'x',
    names: ['x.example.com'],
    notBefore: at(-80),
    notAfter: at(10),
    managed: true,
    agent: 'edge',
    ...overrides,
  };
}

describe('certificateStage', () => {
  it('judges an imported certificate by days alone', () => {
    expect(certificateStage(cert({ managed: false, notAfter: at(20) }), 14, NOW)).toBeNull();
    expect(certificateStage(cert({ managed: false, notAfter: at(5) }), 14, NOW)).toBe('expiring');
    expect(certificateStage(cert({ managed: false, notAfter: at(-1) }), 14, NOW)).toBe('expired');
  });

  it('leaves a managed certificate alone until it is in the last quarter of its life', () => {
    // 90 days long with 10 left: past Caddy's renewal point, so renewal is failing.
    expect(certificateStage(cert({ notBefore: at(-80), notAfter: at(10) }), 14, NOW)).toBe(
      'expiring',
    );
    // A 12-hour internal certificate with 6 hours left is perfectly normal.
    const internal = cert({
      notBefore: new Date(NOW - 6 * 3_600_000).toISOString(),
      notAfter: new Date(NOW + 6 * 3_600_000).toISOString(),
    });
    expect(certificateStage(internal, 14, NOW)).toBeNull();
  });
});

describe('daysLeft', () => {
  it('rounds down and goes negative once expired', () => {
    expect(daysLeft(at(1.5), NOW)).toBe(1);
    expect(daysLeft(at(-0.5), NOW)).toBe(-1);
    expect(daysLeft('not a date', NOW)).toBeNull();
  });
});

describe('hostCertificate', () => {
  const imported = new Map([[7, cert({ certificateId: 7, managed: false, notAfter: at(3) })]]);

  it("uses the host's own imported certificate when it has one", () => {
    const found = hostCertificate(
      { domains: ['a.example.com'], certificateId: 7 },
      imported,
      [],
      14,
      NOW,
    );
    expect(found).toMatchObject({ daysLeft: 3, stage: 'expiring' });
  });

  it('takes the newest managed certificate per name, then the soonest across names', () => {
    const managed = [
      cert({ names: ['a.example.com'], notAfter: at(5) }),
      cert({ names: ['a.example.com'], notAfter: at(60) }),
      cert({ names: ['*.example.com'], notAfter: at(40) }),
    ];
    const found = hostCertificate(
      { domains: ['A.example.com', 'b.example.com'], certificateId: null },
      new Map(),
      managed,
      14,
      NOW,
    );
    expect(found?.daysLeft).toBe(40);
  });

  it('knows nothing without an inventory, or without a match', () => {
    const host = { domains: ['a.example.com'], certificateId: null };
    expect(hostCertificate(host, new Map(), null, 14, NOW)).toBeNull();
    expect(
      hostCertificate(host, new Map(), [cert({ names: ['z.example.com'] })], 14, NOW),
    ).toBeNull();
  });
});

describe('managedExpiry', () => {
  it('names a certificate by its names, falling back to the storage name', () => {
    const base = {
      issuerKey: 'acme',
      issuer: 'R3',
      notBefore: at(-1),
      notAfter: at(89),
      fingerprint: 'ff',
    };
    expect(
      managedExpiry('edge', { ...base, name: 'a', names: ['a.example.com', 'b.example.com'] }).name,
    ).toBe('a.example.com, b.example.com');
    expect(managedExpiry('edge', { ...base, name: 'a.example.com', names: [] }).names).toEqual([
      'a.example.com',
    ]);
  });
});
