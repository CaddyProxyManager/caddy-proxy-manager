/**
 * A throwaway OpenLDAP for the directory tests, started like the test PostgreSQL: a random host
 * port, `--rm`, and gone when the test file ends. Null when Docker is not there, so the tests skip.
 *
 * osixia/openldap's memberOf overlay tracks groupOfUniqueNames. Its bundled CA has expired, so a
 * certificate for `localhost` is made here and copied in before the first start.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ldapts';
import forge from 'node-forge';

const IMAGE = 'osixia/openldap:1.5.0';
const READY_TIMEOUT_MS = 60_000;
export const LDAP_BASE_DN = 'dc=example,dc=org';
export const LDAP_ADMIN_DN = `cn=admin,${LDAP_BASE_DN}`;
export const LDAP_ADMIN_PASSWORD = 'admin';

export type TestLdapServer = {
  ldapUrl: string;
  ldapsUrl: string;
  caPem: string;
  stop: () => Promise<void>;
};

export async function docker(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { code: -1, stdout: '', stderr: String(error) };
  }
}

export async function mappedPort(container: string, port: number): Promise<string> {
  const out = await docker(['port', container, `${port}/tcp`]);
  const mapped = out.stdout.split('\n')[0]?.trim().split(':').pop();
  if (out.code !== 0 || !mapped) throw new Error(`No mapping for ${port}: ${out.stderr}`);
  return mapped;
}

/** A day-long CA and a certificate it signed for `names`. */
export function caSignedCertificate(names: string[] = ['localhost']) {
  const make = (
    subject: string,
    issuer: forge.pki.Certificate | null,
    issuerKey: forge.pki.rsa.PrivateKey | null,
  ) => {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = `0${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60_000);
    cert.setSubject([{ name: 'commonName', value: subject }]);
    cert.setIssuer(issuer ? issuer.subject.attributes : [{ name: 'commonName', value: subject }]);
    cert.setExtensions(
      issuer
        ? [
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true },
            { name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) },
          ]
        : [
            { name: 'basicConstraints', cA: true },
            { name: 'keyUsage', keyCertSign: true, cRLSign: true },
          ],
    );
    cert.sign(issuerKey ?? keys.privateKey, forge.md.sha256.create());
    return { cert, key: keys.privateKey };
  };
  const ca = make('CPM test LDAP CA', null, null);
  const leaf = make(names[0], ca.cert, ca.key);
  return {
    caPem: forge.pki.certificateToPem(ca.cert),
    certificatePem: forge.pki.certificateToPem(leaf.cert),
    privateKeyPem: forge.pki.privateKeyToPem(leaf.key),
  };
}

export async function startLdapServer(): Promise<TestLdapServer | null> {
  if ((await docker(['version', '--format', '{{.Server.Version}}'])).code !== 0) return null;

  const container = `cpm-test-ldap-${process.pid}-${Date.now()}`;
  const run = await docker([
    'create',
    '--rm',
    '--name',
    container,
    '--hostname',
    'localhost',
    // The image's default demands a client certificate.
    '-e',
    'LDAP_TLS_VERIFY_CLIENT=never',
    '-p',
    '0:389',
    '-p',
    '0:636',
    IMAGE,
  ]);
  if (run.code !== 0) throw new Error(`Could not create ${IMAGE}: ${run.stderr || run.stdout}`);
  const stop = async () => {
    await docker(['rm', '-f', container]);
  };

  try {
    // The image uses files already there instead of making some.
    const { caPem: certificateAuthorityPem, certificatePem, privateKeyPem } = caSignedCertificate();
    const certs = mkdtempSync(join(tmpdir(), 'cpm-ldap-certs-'));
    try {
      writeFileSync(join(certs, 'ldap.crt'), certificatePem);
      writeFileSync(join(certs, 'ca.crt'), certificateAuthorityPem);
      writeFileSync(join(certs, 'ldap.key'), privateKeyPem);
      const copy = await docker([
        'cp',
        `${certs}/.`,
        `${container}:/container/service/slapd/assets/certs/`,
      ]);
      if (copy.code !== 0) throw new Error(`Could not copy the certificates: ${copy.stderr}`);
    } finally {
      rmSync(certs, { recursive: true, force: true });
    }
    const start = await docker(['start', container]);
    if (start.code !== 0) throw new Error(`Could not start ${IMAGE}: ${start.stderr}`);

    const ldapUrl = `ldap://localhost:${await mappedPort(container, 389)}`;
    const ldapsUrl = `ldaps://localhost:${await mappedPort(container, 636)}`;

    // The image runs slapd once to bootstrap, then restarts it with TLS: a bind can succeed
    // against the first and be cut off by the restart. Ready is a verified LDAPS bind.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const caPem = certificateAuthorityPem;
    let lastError: unknown = null;
    for (;;) {
      const client = new Client({
        url: ldapsUrl,
        connectTimeout: 2_000,
        timeout: 2_000,
        tlsOptions: { ca: [caPem] },
      });
      try {
        await client.bind(LDAP_ADMIN_DN, LDAP_ADMIN_PASSWORD);
        await client.unbind();
        break;
      } catch (error) {
        lastError = error;
        await client.unbind().catch(() => {});
      }
      if (Date.now() > deadline) throw new Error(`${IMAGE} was not ready in time: ${lastError}`);
      await Bun.sleep(500);
    }

    await seed(ldapUrl);
    return { ldapUrl, ldapsUrl, caPem, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export const LDAP_PASSWORDS = {
  alice: 'Alice-directory-2026!',
  bob: 'Bob-directory-2026!',
  twin: 'Twin-directory-2026!',
} as const;

async function seed(url: string): Promise<void> {
  const client = new Client({ url });
  await client.bind(LDAP_ADMIN_DN, LDAP_ADMIN_PASSWORD);
  try {
    for (const ou of ['people', 'contractors', 'groups']) {
      await client.add(`ou=${ou},${LDAP_BASE_DN}`, {
        objectClass: ['organizationalUnit'],
        ou,
      });
    }
    const person = (uid: string, ou: string, password: string, mail?: string) =>
      client.add(`uid=${uid},ou=${ou},${LDAP_BASE_DN}`, {
        objectClass: ['inetOrgPerson'],
        uid,
        cn: uid,
        sn: uid,
        displayName: `${uid[0].toUpperCase()}${uid.slice(1)} Example`,
        userPassword: password,
        ...(mail ? { mail } : {}),
      });
    await person('alice', 'people', LDAP_PASSWORDS.alice, 'alice@example.org');
    // No mail: the account gets a placeholder address.
    await person('bob', 'people', LDAP_PASSWORDS.bob);
    // The same uid twice, for the "exactly one entry" rule.
    await person('twin', 'people', LDAP_PASSWORDS.twin, 'twin1@example.org');
    await person('twin', 'contractors', LDAP_PASSWORDS.twin, 'twin2@example.org');
    // Added after the users, which is when the memberOf overlay fills in their memberOf.
    await client.add(`cn=Proxy Admins,ou=groups,${LDAP_BASE_DN}`, {
      objectClass: ['groupOfUniqueNames'],
      cn: 'Proxy Admins',
      uniqueMember: [`uid=alice,ou=people,${LDAP_BASE_DN}`],
    });
    await client.add(`cn=Staff,ou=groups,${LDAP_BASE_DN}`, {
      objectClass: ['groupOfUniqueNames'],
      cn: 'Staff',
      uniqueMember: [`uid=alice,ou=people,${LDAP_BASE_DN}`, `uid=bob,ou=people,${LDAP_BASE_DN}`],
    });
  } finally {
    await client.unbind();
  }
}
