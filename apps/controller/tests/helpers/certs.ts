import forge from 'node-forge';

export interface GeneratedCertificate {
  certificatePem: string;
  privateKeyPem: string;
}

export interface Pkcs12Identity {
  certificatePem: string;
  privateKeyPem: string;
}

function randomSerialNumber(): string {
  const bytes = forge.random.getBytesSync(16).split('');
  const firstByte = bytes[0]?.charCodeAt(0) ?? 1;
  bytes[0] = String.fromCharCode(firstByte & 0x7f || 1);
  return forge.util.bytesToHex(bytes.join(''));
}

export function createSelfSignedServerCertificate(
  commonName: string,
  altNames: string[],
  validityDays = 30,
): GeneratedCertificate {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();

  cert.publicKey = keypair.publicKey;
  cert.serialNumber = randomSerialNumber();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + validityDays);

  const subject = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'Caddy Proxy Manager E2E' },
  ];

  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: altNames.map((value) => ({ type: 2, value })),
    },
  ]);

  cert.sign(keypair.privateKey, forge.md.sha256.create());

  return {
    certificatePem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keypair.privateKey),
  };
}

export function parsePkcs12Identity(bundle: Buffer, password: string): Pkcs12Identity {
  const der = forge.util.createBuffer(bundle.toString('binary'));
  const p12Asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags =
    p12.getBags({
      bagType: forge.pki.oids.pkcs8ShroudedKeyBag,
    })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const key = keyBags[0]?.key;
  if (!key) {
    throw new Error('PKCS#12 bundle did not contain a private key');
  }

  const certBags =
    p12.getBags({
      bagType: forge.pki.oids.certBag,
    })[forge.pki.oids.certBag] ?? [];
  const certBag =
    certBags.find((bag) => {
      const extKeyUsage = bag.cert?.getExtension('extKeyUsage');
      const basicConstraints = bag.cert?.getExtension('basicConstraints');
      const isClientCert = Boolean(
        extKeyUsage && 'clientAuth' in extKeyUsage && extKeyUsage.clientAuth,
      );
      const isCa = Boolean(basicConstraints && 'cA' in basicConstraints && basicConstraints.cA);
      return isClientCert || !isCa;
    }) ?? certBags[0];

  if (!certBag?.cert) {
    throw new Error('PKCS#12 bundle did not contain a certificate');
  }

  return {
    certificatePem: forge.pki.certificateToPem(certBag.cert),
    privateKeyPem: forge.pki.privateKeyToPem(key),
  };
}

export interface TestCa extends GeneratedCertificate {
  issue(hostname: string): GeneratedCertificate;
}

/** A CA and leaves it signs: a self-signed leaf trusted as its own CA fails Bun's chain check. */
export function createTestCa(validityDays = 1): TestCa {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const caCert = forge.pki.createCertificate();
  const subject = [{ name: 'commonName', value: 'Caddy Proxy Manager Test CA' }];
  caCert.publicKey = keypair.publicKey;
  caCert.serialNumber = randomSerialNumber();
  caCert.validity.notBefore = new Date(Date.now() - 60_000);
  caCert.validity.notAfter = new Date(Date.now() + validityDays * 86_400_000);
  caCert.setSubject(subject);
  caCert.setIssuer(subject);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  caCert.sign(keypair.privateKey, forge.md.sha256.create());

  return {
    certificatePem: forge.pki.certificateToPem(caCert),
    privateKeyPem: forge.pki.privateKeyToPem(keypair.privateKey),
    issue(hostname) {
      const leafKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
      const leaf = forge.pki.createCertificate();
      leaf.publicKey = leafKeys.publicKey;
      leaf.serialNumber = randomSerialNumber();
      leaf.validity.notBefore = caCert.validity.notBefore;
      leaf.validity.notAfter = caCert.validity.notAfter;
      leaf.setSubject([{ name: 'commonName', value: hostname }]);
      leaf.setIssuer(subject);
      leaf.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
      ]);
      leaf.sign(keypair.privateKey, forge.md.sha256.create());
      return {
        certificatePem: forge.pki.certificateToPem(leaf),
        privateKeyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
      };
    },
  };
}
