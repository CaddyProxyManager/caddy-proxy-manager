/**
 * A SAML identity provider in a function: its metadata, and responses signed (or not, or badly)
 * with its test key, for driving the plugin's assertion consumer the way a real IdP would.
 */
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { createSelfSignedServerCertificate } from './certs';

export const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export type TestKey = { certificatePem: string; privateKeyPem: string; certificateBase64: string };

export function createTestKey(name = 'idp.test'): TestKey {
  const { certificatePem, privateKeyPem } = createSelfSignedServerCertificate(name, [name], 2);
  const certificateBase64 = certificatePem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  return { certificatePem, privateKeyPem, certificateBase64 };
}

export type TestIdp = {
  entityId: string;
  ssoUrl: string;
  key: TestKey;
  metadata: () => string;
};

export function createTestIdp(entityId = 'https://idp.test/realms/cpm'): TestIdp {
  const key = createTestKey();
  const ssoUrl = `${entityId}/protocol/saml`;
  return {
    entityId,
    ssoUrl,
    key,
    metadata: () =>
      `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo><ds:X509Data><ds:X509Certificate>${key.certificateBase64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${ssoUrl}"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`,
  };
}

/** The AuthnRequest a sign-in redirect carries, and the RelayState beside it. */
export function readAuthnRequest(url: string): { id: string; relayState: string; xml: string } {
  const parsed = new URL(url);
  const encoded = parsed.searchParams.get('SAMLRequest') ?? '';
  const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  const id = /\bID="([^"]+)"/.exec(xml)?.[1] ?? '';
  return { id, relayState: parsed.searchParams.get('RelayState') ?? '', xml };
}

export type ResponseOptions = {
  inResponseTo?: string | null;
  destination: string;
  recipient?: string;
  audience?: string | null;
  issuer?: string;
  nameId?: string;
  attributes?: Record<string, string | string[]>;
  /** Null leaves the attribute out. */
  notBefore?: Date | null;
  notOnOrAfter?: Date | null;
  assertionId?: string;
};

const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildAssertion(idp: TestIdp, options: ResponseOptions): string {
  const now = new Date();
  const notBefore =
    options.notBefore === undefined ? new Date(now.getTime() - 30_000) : options.notBefore;
  const notOnOrAfter =
    options.notOnOrAfter === undefined
      ? new Date(now.getTime() + 5 * 60_000)
      : options.notOnOrAfter;
  const timing = [
    notBefore ? ` NotBefore="${iso(notBefore)}"` : '',
    notOnOrAfter ? ` NotOnOrAfter="${iso(notOnOrAfter)}"` : '',
  ].join('');
  const confirmationTiming = notOnOrAfter ? ` NotOnOrAfter="${iso(notOnOrAfter)}"` : '';
  const inResponseTo = options.inResponseTo ? ` InResponseTo="${options.inResponseTo}"` : '';
  const audience =
    options.audience === null
      ? ''
      : `<saml:AudienceRestriction><saml:Audience>${escapeXml(options.audience ?? '')}</saml:Audience></saml:AudienceRestriction>`;
  const conditions =
    timing || audience ? `<saml:Conditions${timing}>${audience}</saml:Conditions>` : '';
  const attributes = Object.entries(options.attributes ?? {})
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${escapeXml(name)}">${(Array.isArray(value) ? value : [value])
          .map((v) => `<saml:AttributeValue>${escapeXml(v)}</saml:AttributeValue>`)
          .join('')}</saml:Attribute>`,
    )
    .join('');
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${options.assertionId ?? `_${randomUUID()}`}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${escapeXml(options.issuer ?? idp.entityId)}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${escapeXml(options.nameId ?? 'user-1')}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponseTo}${confirmationTiming} Recipient="${escapeXml(options.recipient ?? options.destination)}"/></saml:SubjectConfirmation></saml:Subject>${conditions}<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attributes}</saml:AttributeStatement></saml:Assertion>`;
}

export function wrapInResponse(idp: TestIdp, options: ResponseOptions, assertions: string): string {
  const inResponseTo = options.inResponseTo ? ` InResponseTo="${options.inResponseTo}"` : '';
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${iso(new Date())}" Destination="${escapeXml(options.destination)}"${inResponseTo}><saml:Issuer>${escapeXml(options.issuer ?? idp.entityId)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertions}</samlp:Response>`;
}

export type SignOptions = {
  key: TestKey;
  algorithm?: 'sha256' | 'sha1';
  /** Which element to sign: `Assertion` (inside it, after its Issuer) or the whole `Response`. */
  target: 'Assertion' | 'Response';
  /** The ID of the element to sign, when several share a name. */
  id?: string;
};

export function sign(xml: string, options: SignOptions): string {
  const sha1 = options.algorithm === 'sha1';
  const signed = new SignedXml({
    privateKey: options.key.privateKeyPem,
    publicCert: options.key.certificatePem,
    signatureAlgorithm: sha1 ? RSA_SHA1 : RSA_SHA256,
    canonicalizationAlgorithm: EXC_C14N,
  });
  const select = options.id
    ? `//*[local-name(.)='${options.target}' and @ID='${options.id}']`
    : `//*[local-name(.)='${options.target}']`;
  signed.addReference({
    xpath: select,
    digestAlgorithm: sha1 ? SHA1 : SHA256,
    transforms: [ENVELOPED, EXC_C14N],
  });
  signed.computeSignature(xml, {
    prefix: 'ds',
    location: { reference: `${select}/*[local-name(.)='Issuer']`, action: 'after' },
  });
  return signed.getSignedXml();
}

/** A signed assertion, in a response, as a well-behaved IdP sends it. */
export function signedResponse(
  idp: TestIdp,
  options: ResponseOptions,
  sign_: Partial<SignOptions> = {},
): string {
  const assertion = sign(buildAssertion(idp, options), {
    key: idp.key,
    target: 'Assertion',
    ...sign_,
  });
  return wrapInResponse(idp, options, assertion);
}

export function encodeResponse(xml: string): string {
  return Buffer.from(xml, 'utf8').toString('base64');
}
