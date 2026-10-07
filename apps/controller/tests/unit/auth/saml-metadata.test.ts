import { describe, expect, it } from 'bun:test';
import {
  MAX_IDP_METADATA_BYTES,
  fetchIdpMetadata,
  readIdpMetadata,
  withUnsignedRequests,
} from '@/src/lib/auth/saml/metadata';
import { OutboundError } from '@/src/lib/http/outbound';
import { createTestIdp } from '@/tests/helpers/saml-idp';

const idp = createTestIdp('https://idp.example.com/saml');

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'thrown';
  }
}

describe('readIdpMetadata', () => {
  it('reads the entity, the redirect sign-on URL and the signing certificate', () => {
    expect(readIdpMetadata(idp.metadata())).toEqual({
      entityId: 'https://idp.example.com/saml',
      ssoUrl: 'https://idp.example.com/saml/protocol/saml',
      signingCertificates: [idp.key.certificateBase64],
    });
  });

  it('counts a key with no `use` as a signing key, and skips an encryption-only one', () => {
    const both = idp.metadata().replace(' use="signing"', '');
    expect(readIdpMetadata(both).signingCertificates).toHaveLength(1);
    const encryption = idp.metadata().replace('use="signing"', 'use="encryption"');
    expect(codeOf(() => readIdpMetadata(encryption))).toBe('samlMetadataNoSigningCertificate');
  });

  it('refuses what a sign-in could not use', () => {
    const noRedirect = idp
      .metadata()
      .replace(/<md:SingleSignOnService Binding="[^"]*HTTP-Redirect"[^>]*\/>/, '');
    expect(codeOf(() => readIdpMetadata(noRedirect))).toBe('samlMetadataNoRedirectBinding');
    const sp = idp.metadata().replace(/IDPSSODescriptor/g, 'SPSSODescriptor');
    expect(codeOf(() => readIdpMetadata(sp))).toBe('samlMetadataNotIdp');
    const many = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${idp.metadata().replace(/^<\?xml[^>]*>/, '')}</md:EntitiesDescriptor>`;
    expect(codeOf(() => readIdpMetadata(many))).toBe('samlMetadataManyEntities');
  });

  it('refuses what is not metadata at all', () => {
    expect(codeOf(() => readIdpMetadata(''))).toBe('samlMetadataRequired');
    expect(codeOf(() => readIdpMetadata('not xml'))).toBe('samlMetadataInvalid');
    expect(codeOf(() => readIdpMetadata('<a><b></a>'))).toBe('samlMetadataInvalid');
    expect(codeOf(() => readIdpMetadata('<EntityDescriptor entityID="x"/>'))).toBe(
      'samlMetadataInvalid',
    );
    const noEntity = idp.metadata().replace(/entityID="[^"]*"/, '');
    expect(codeOf(() => readIdpMetadata(noEntity))).toBe('samlMetadataInvalid');
  });

  it('refuses a document type declaration, where entity expansion starts', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]>${idp
      .metadata()
      .replace(/^<\?xml[^>]*>/, '')}`;
    expect(codeOf(() => readIdpMetadata(bomb))).toBe('samlMetadataInvalid');
  });

  it('refuses metadata larger than the plugin will read back', () => {
    const padding = `<!--${'x'.repeat(MAX_IDP_METADATA_BYTES)}-->`;
    expect(codeOf(() => readIdpMetadata(idp.metadata() + padding))).toBe('samlMetadataTooLarge');
  });
});

describe('withUnsignedRequests', () => {
  it("drops the IdP's ask for signed requests, and nothing else", () => {
    const xml = idp.metadata();
    expect(xml).toContain('WantAuthnRequestsSigned="true"');
    const stored = withUnsignedRequests(xml);
    expect(stored).toBe(
      xml.replace('WantAuthnRequestsSigned="true"', 'WantAuthnRequestsSigned="false"'),
    );
    expect(withUnsignedRequests(stored)).toBe(stored);
    expect(readIdpMetadata(stored)).toEqual(readIdpMetadata(xml));
  });

  it('reads any prefix and quoting', () => {
    expect(
      withUnsignedRequests(
        "<IDPSSODescriptor protocolSupportEnumeration='x' WantAuthnRequestsSigned='1'>",
      ),
    ).toBe("<IDPSSODescriptor protocolSupportEnumeration='x' WantAuthnRequestsSigned='false'>");
    // An SP descriptor's flag is not the IdP's to drop.
    const sp = '<md:SPSSODescriptor WantAuthnRequestsSigned="true">';
    expect(withUnsignedRequests(sp)).toBe(sp);
  });
});

describe('fetchIdpMetadata', () => {
  it('returns the body of a successful fetch', async () => {
    const seen: string[] = [];
    const xml = await fetchIdpMetadata('https://idp.example.com/metadata', async (url) => {
      seen.push(String(url));
      return new Response(idp.metadata());
    });
    expect(seen).toEqual(['https://idp.example.com/metadata']);
    expect(readIdpMetadata(xml).entityId).toBe('https://idp.example.com/saml');
  });

  async function codeOfAsync(run: () => Promise<unknown>) {
    try {
      await run();
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'thrown';
    }
  }

  it('refuses an address that is not http(s), before fetching anything', async () => {
    let called = false;
    const fetcher = async () => {
      called = true;
      return new Response('');
    };
    expect(await codeOfAsync(() => fetchIdpMetadata('file:///etc/passwd', fetcher))).toBe(
      'samlMetadataUrlInvalid',
    );
    expect(await codeOfAsync(() => fetchIdpMetadata('not a url', fetcher))).toBe(
      'samlMetadataUrlInvalid',
    );
    expect(called).toBe(false);
  });

  it('reports an error status or a refused connection as a failed fetch', async () => {
    expect(
      await codeOfAsync(() =>
        fetchIdpMetadata(
          'https://idp.example.com/m',
          async () => new Response('', { status: 503 }),
        ),
      ),
    ).toBe('samlMetadataFetchFailed');
    expect(
      await codeOfAsync(() =>
        fetchIdpMetadata('https://idp.example.com/m', async () => {
          throw new OutboundError('metadata', 'refused');
        }),
      ),
    ).toBe('samlMetadataFetchFailed');
  });
});
