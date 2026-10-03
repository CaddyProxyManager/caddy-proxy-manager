/**
 * A throwaway Samba 4 Active Directory domain controller, for what OpenLDAP cannot show: objectGUID,
 * sAMAccountName and UPNs, nested groups through LDAP_MATCHING_RULE_IN_CHAIN, disabled accounts.
 * Started like ldap-server.ts and null without Docker, so the tests skip.
 *
 * Samba's own certificate names only the DC's FQDN, which nothing on the host resolves, so it is
 * given one for `localhost` too. The image switches off AD's refusal of simple binds in the clear;
 * it is switched back on, so a directory has to use LDAPS or StartTLS as against a real DC.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ldapts';
import { caSignedCertificate, docker, mappedPort } from '@/tests/helpers/ldap-server';

const IMAGE = 'diegogslomp/samba-ad-dc:4.24.7';
// Provisioning takes seconds, but a first run pulls the image inside this wait's budget too.
const READY_TIMEOUT_MS = 180_000;

export const AD_REALM = 'ad.cpm.test';
export const AD_HOST = `dc1.${AD_REALM}`;
export const AD_BASE_DN = 'DC=ad,DC=cpm,DC=test';
/** The NetBIOS domain name, for down-level logon names such as `CPM\alice`. */
export const AD_DOMAIN = 'CPM';
export const AD_ADMIN_UPN = `Administrator@${AD_REALM}`;
export const AD_ADMIN_PASSWORD = 'Admin-directory-2026!';
/** An ordinary user, as a service account should be: AD lets any user read memberships. */
export const AD_SERVICE_UPN = `svc-cpm@${AD_REALM}`;

export const AD_PASSWORDS = {
  service: 'Service-directory-2026!',
  alice: 'Alice-directory-2026!',
  bob: 'Bob-directory-2026!',
  carol: 'Carol-directory-2026!',
} as const;

export type TestActiveDirectory = {
  ldapUrl: string;
  ldapsUrl: string;
  caPem: string;
  /** `samba-tool` in the container; throws on a non-zero exit. */
  sambaTool: (...args: string[]) => Promise<string>;
  /** objectGUID as Samba itself prints it, to check ours against. */
  objectGuid: (sAMAccountName: string) => Promise<string>;
  stop: () => Promise<void>;
};

// Runs as the container's command, so the TLS and strong-auth settings are in place at first start.
const SETUP = String.raw`#!/usr/bin/env bash
set -euo pipefail
samba-domain-provision
conf=/usr/local/samba/etc/smb.conf
sed -i '/ldap server require strong auth/d' "$conf"
sed -i 's|^\[global\]$|[global]\n\tldap server require strong auth = yes\n\ttls enabled = yes\n\ttls keyfile = /cpm/tls/key.pem\n\ttls certfile = /cpm/tls/cert.pem\n\ttls cafile = /cpm/tls/ca.pem|' "$conf"
# Samba refuses a key anyone else can read or own; docker cp keeps the host uid (1001 on CI).
chown root:root /cpm/tls/key.pem
chmod 600 /cpm/tls/key.pem
# Otherwise it logs to a file, and a start that fails prints nothing docker logs can show.
exec samba -F --debug-stdout
`;

export async function startActiveDirectory(): Promise<TestActiveDirectory | null> {
  if ((await docker(['version', '--format', '{{.Server.Version}}'])).code !== 0) return null;

  const container = `cpm-test-ad-${process.pid}-${Date.now()}`;
  // No --rm: a DC that exits during provisioning would take the log saying why with it.
  const create = await docker([
    'create',
    '--name',
    container,
    '--hostname',
    'dc1',
    // Provisioning writes the sysvol's NT ACLs as security.* xattrs.
    '--cap-add',
    'SYS_ADMIN',
    '-e',
    `REALM=${AD_REALM.toUpperCase()}`,
    '-e',
    `DOMAIN=${AD_DOMAIN}`,
    '-e',
    `ADMIN_PASS=${AD_ADMIN_PASSWORD}`,
    '-e',
    'DNS_FORWARDER=127.0.0.11',
    '-e',
    'BIND_NETWORK_INTERFACES=false',
    '-p',
    '0:389',
    '-p',
    '0:636',
    IMAGE,
    'bash',
    '/cpm/setup.sh',
  ]);
  if (create.code !== 0) {
    throw new Error(`Could not create ${IMAGE}: ${create.stderr || create.stdout}`);
  }
  const stop = async () => {
    await docker(['rm', '-f', container]);
  };

  const sambaTool = async (...args: string[]) => {
    const out = await docker(['exec', container, 'samba-tool', ...args]);
    if (out.code !== 0) throw new Error(`samba-tool ${args[0]} ${args[1]}: ${out.stderr}`);
    return out.stdout;
  };

  try {
    const { caPem, certificatePem, privateKeyPem } = caSignedCertificate(['localhost', AD_HOST]);
    const files = mkdtempSync(join(tmpdir(), 'cpm-samba-'));
    try {
      mkdirSync(join(files, 'tls'));
      writeFileSync(join(files, 'setup.sh'), SETUP);
      writeFileSync(join(files, 'tls', 'ca.pem'), caPem);
      writeFileSync(join(files, 'tls', 'cert.pem'), certificatePem);
      writeFileSync(join(files, 'tls', 'key.pem'), privateKeyPem);
      const copy = await docker(['cp', `${files}/.`, `${container}:/cpm/`]);
      if (copy.code !== 0) throw new Error(`Could not copy the setup files: ${copy.stderr}`);
    } finally {
      rmSync(files, { recursive: true, force: true });
    }
    const start = await docker(['start', container]);
    if (start.code !== 0) throw new Error(`Could not start ${IMAGE}: ${start.stderr}`);

    const ldapUrl = `ldap://localhost:${await mappedPort(container, 389)}`;
    const ldapsUrl = `ldaps://localhost:${await mappedPort(container, 636)}`;

    // Ready is a verified LDAPS bind: the port answers before provisioning is done.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError: unknown = null;
    for (;;) {
      const client = new Client({
        url: ldapsUrl,
        connectTimeout: 2_000,
        timeout: 5_000,
        tlsOptions: { ca: [caPem] },
      });
      try {
        await client.bind(AD_ADMIN_UPN, AD_ADMIN_PASSWORD);
        await client.unbind();
        break;
      } catch (error) {
        lastError = error;
        await client.unbind().catch(() => {});
      }
      // A DC that exited will not come up; say why now rather than at the deadline.
      const state = await docker([
        'inspect',
        '-f',
        '{{.State.Status}} {{.State.ExitCode}}',
        container,
      ]);
      const exited = state.stdout.trim().startsWith('exited');
      if (exited || Date.now() > deadline) {
        const logs = await docker(['logs', '--tail', '40', container]);
        const why = exited ? `exited (${state.stdout.trim()})` : 'not ready in time';
        throw new Error(`${IMAGE} ${why}: ${lastError}\n${logs.stdout}${logs.stderr}`);
      }
      await Bun.sleep(1_000);
    }

    await provision(sambaTool);
    const objectGuid = async (name: string) => {
      const shown = await sambaTool('user', 'show', name, '--attributes=objectGUID');
      const guid = shown.match(/^objectGUID: (\S+)$/m)?.[1];
      if (!guid) throw new Error(`No objectGUID for ${name}: ${shown}`);
      return guid;
    };
    return { ldapUrl, ldapsUrl, caPem, sambaTool, objectGuid, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * alice is in Engineering, which is inside Proxy Admins: an admin only when nesting is followed.
 * bob has no mail; carol is disabled.
 */
async function provision(sambaTool: TestActiveDirectory['sambaTool']): Promise<void> {
  await sambaTool('user', 'create', 'svc-cpm', AD_PASSWORDS.service);
  await sambaTool(
    'user',
    'create',
    'alice',
    AD_PASSWORDS.alice,
    '--given-name=Alice',
    '--surname=Example',
    `--mail-address=alice@${AD_REALM}`,
  );
  await sambaTool(
    'user',
    'create',
    'bob',
    AD_PASSWORDS.bob,
    '--given-name=Bob',
    '--surname=Example',
  );
  await sambaTool(
    'user',
    'create',
    'carol',
    AD_PASSWORDS.carol,
    '--given-name=Carol',
    '--surname=Example',
    `--mail-address=carol@${AD_REALM}`,
  );
  await sambaTool('user', 'disable', 'carol');
  for (const group of ['Proxy Admins', 'Engineering', 'Staff']) {
    await sambaTool('group', 'add', group);
  }
  await sambaTool('group', 'addmembers', 'Proxy Admins', 'Engineering');
  await sambaTool('group', 'addmembers', 'Engineering', 'alice,carol');
  await sambaTool('group', 'addmembers', 'Staff', 'alice,bob');
}
