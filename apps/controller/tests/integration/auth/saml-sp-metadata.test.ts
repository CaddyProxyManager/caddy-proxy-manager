/**
 * The service provider metadata an administrator hands their identity provider, validated against
 * the OASIS SAML 2.0 metadata schema (tests/fixtures/saml-schemas, fetched from OASIS and the
 * W3C unchanged but for LF line endings; their absolute imports are pointed at the copies here).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateXML } from 'xmllint-wasm';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';
import { vi } from '@/tests/helpers/vi';
import { CookieJar, bootSaml, registerSamlCleanup } from '@/tests/helpers/saml-harness';

vi.mock('next-intl/server', () => nextIntlServerMock());
registerSamlCleanup();

const SCHEMAS = join(import.meta.dir, '..', '..', 'fixtures', 'saml-schemas');

function schemaFiles() {
  return readdirSync(SCHEMAS)
    .filter((name) => name.endsWith('.xsd'))
    .map((fileName) => ({
      fileName,
      contents: readFileSync(join(SCHEMAS, fileName), 'utf8').replace(
        /schemaLocation=(["'])https?:\/\/[^"']*\/([^/"']+\.xsd)\1/g,
        'schemaLocation="$2"',
      ),
    }));
}

async function validateMetadata(xml: string) {
  const files = schemaFiles();
  const entry = files.find((file) => file.fileName === 'saml-schema-metadata-2.0.xsd');
  if (!entry) throw new Error('metadata schema missing');
  return validateXML({
    xml: [{ fileName: 'sp-metadata.xml', contents: xml }],
    schema: [entry],
    preload: files.filter((file) => file !== entry),
  });
}

describe('service provider metadata', () => {
  it('validates against the SAML metadata schema and asks for signed assertions', async () => {
    const h = await bootSaml();
    const response = await h.call(
      new CookieJar(),
      'GET',
      `/sso/saml2/sp/metadata?providerId=${encodeURIComponent(h.provider.id)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('xml');
    const xml = await response.text();

    const result = await validateMetadata(xml);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);

    expect(xml).toContain(`entityID="${h.provider.spEntityId}"`);
    expect(xml).toMatch(/WantAssertionsSigned="true"/);
    expect(xml).toContain(`Location="${h.acsUrl}"`);
  });

  it('a broken document fails the same check, so the check is not vacuous', async () => {
    const result = await validateMetadata(
      '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"><md:Nonsense/></md:EntityDescriptor>',
    );
    expect(result.valid).toBe(false);
  });

  it('answers for a disabled provider, and not for one that does not exist', async () => {
    const h = await bootSaml({ provider: { enabled: false } });
    const jar = new CookieJar();
    const disabled = await h.call(jar, 'GET', `/sso/saml2/sp/metadata?providerId=${h.provider.id}`);
    expect(disabled.status).toBe(200);
    const unknown = await h.call(jar, 'GET', '/sso/saml2/sp/metadata?providerId=nope');
    expect(unknown.status).toBe(404);
  });
});
