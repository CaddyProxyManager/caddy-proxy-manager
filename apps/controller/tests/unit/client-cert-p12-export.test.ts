import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import forge from 'node-forge';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// The action translates the password rule, and a unit test has no request to resolve one from.
vi.mock('next-intl/server', () => nextIntlServerMock());

vi.mock('@/src/lib/auth', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: '1' } }),
}));

vi.mock('@/src/lib/models/ca-certificates', () => ({
  createCaCertificate: vi.fn(),
  deleteCaCertificate: vi.fn(),
  updateCaCertificate: vi.fn(),
  getCaCertificatePrivateKey: vi.fn(),
  getCaCertificate: vi.fn(),
}));

vi.mock('@/src/lib/models/issued-client-certificates', () => ({
  createIssuedClientCertificate: vi.fn(),
  revokeIssuedClientCertificate: vi.fn(),
}));

import {
  generateCaCertificateAction,
  issueClientCertificateAction,
} from '@/src/app/(dashboard)/certificates/ca-actions';
import {
  createCaCertificate,
  getCaCertificate,
  getCaCertificatePrivateKey,
} from '@/src/lib/models/ca-certificates';
import { createIssuedClientCertificate } from '@/src/lib/models/issued-client-certificates';

/** DER bytes of an OID, so the assertions below read as algorithm names. */
const oid = (dotted: string) =>
  Buffer.from(forge.asn1.oidToDer(dotted).getBytes(), 'binary').toString('hex');

const HMAC_WITH_SHA256 = oid('1.2.840.113549.2.9');
const HMAC_WITH_SHA1 = oid('1.2.840.113549.2.7');
const AES_256_CBC = oid('2.16.840.1.101.3.4.1.42');
const PBE_3DES = oid('1.2.840.113549.1.12.1.3');

function makeCa() {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86_400_000);
  const attrs = [{ name: 'commonName', value: 'Test CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }]);
  cert.sign(keypair.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keypair.privateKey),
  };
}

async function issue(password = 'Correct-Horse-Battery-Staple1!') {
  const form = new FormData();
  form.set('common_name', 'alice');
  form.set('validity_days', '365');
  form.set('export_password', password);
  const result = await issueClientCertificateAction(1, form);
  return Buffer.from(result.pkcs12Base64, 'base64');
}

describe('client certificate .p12 export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const ca = makeCa();
    vi.mocked(getCaCertificatePrivateKey).mockResolvedValue(ca.privateKeyPem);
    vi.mocked(getCaCertificate).mockResolvedValue({
      id: 1,
      name: 'Test CA',
      certificatePem: ca.certificatePem,
    } as never);
    vi.mocked(createIssuedClientCertificate).mockResolvedValue({ id: 1 } as never);
  });

  it('stretches the export password with PBKDF2-SHA256, not SHA-1', async () => {
    // `prfAlgorithm` is an undeclared pass-through in forge; if an upgrade drops it the PRF
    // silently reverts to SHA-1.
    const der = (await issue()).toString('hex');
    expect(der).toContain(HMAC_WITH_SHA256);
    expect(der).not.toContain(HMAC_WITH_SHA1);
  });

  it('encrypts with AES-256 and never the legacy 3DES PBE', async () => {
    const der = (await issue()).toString('hex');
    expect(der).toContain(AES_256_CBC);
    expect(der).not.toContain(PBE_3DES);
  });

  it('round-trips: the bundle opens with the export password', async () => {
    const password = 'Correct-Horse-Battery-Staple1!';
    const der = await issue(password);
    const p12 = forge.pkcs12.pkcs12FromAsn1(
      forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary'))),
      password,
    );
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ];
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    expect(keyBags).toHaveLength(1);
    // the client certificate plus the CA, so importers get the whole chain
    expect(certBags).toHaveLength(2);
  });

  it('refuses an export password weaker than a login password', async () => {
    // Once the .p12 leaves as a file, this password is all that protects the private key.
    for (const weak of ['short', 'alllowercaseletters1!', 'NoDigitsInHere!!', 'NoSpecialChar123']) {
      await expect(issue(weak)).rejects.toThrow(/Export password must/);
    }
  });

  it('still refuses an empty export password', async () => {
    await expect(issue('')).rejects.toThrow(/Export password is required/);
  });

  it('does no key generation when the password is rejected', async () => {
    // Otherwise a rejected request still costs the 2048-bit keygen and the database write.
    await expect(issue('short')).rejects.toThrow();
    expect(createIssuedClientCertificate).not.toHaveBeenCalled();
  });

  it('rejects the wrong export password', async () => {
    const der = await issue('Correct-Horse-Battery-Staple1!');
    expect(() =>
      forge.pkcs12.pkcs12FromAsn1(
        forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary'))),
        'wrong-password',
      ),
    ).toThrow();
  });
});

describe('CA generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createCaCertificate).mockResolvedValue({ id: 7 } as never);
  });

  it('produces a usable 4096-bit CA from the async keygen path', async () => {
    const form = new FormData();
    form.set('name', 'Internal CA');
    form.set('common_name', 'Internal CA');
    form.set('validity_days', '3650');

    const result = await generateCaCertificateAction(form);
    expect(result.id).toBe(7);

    const [input] = vi.mocked(createCaCertificate).mock.calls[0];
    const { certificatePem, privateKeyPem } = input;
    expect(privateKeyPem).toBeDefined();

    const cert = forge.pki.certificateFromPem(certificatePem);
    const key = forge.pki.privateKeyFromPem(privateKeyPem as string);
    // pki.Certificate types publicKey as a union; an RSA CA always carries a modulus
    const certPublicKey = cert.publicKey as forge.pki.rsa.PublicKey;

    expect(certPublicKey.n.bitLength()).toBe(4096);
    expect(key.n.bitLength()).toBe(4096);
    // the stored PEM stays PKCS#1, the shape forge emitted before the swap
    expect(privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
    // self-signed: the CA's own key must verify its certificate
    expect(cert.verify(cert)).toBe(true);
  });
});
