/**
 * An identity provider's SAML metadata, checked for what a sign-in needs before it is saved: one
 * entity, a redirect-binding sign-on URL (the plugin sends its request that way) and a signing
 * certificate. Saving refuses anything else, so a broken provider fails in Settings, not at /login.
 */
import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import { domainError } from "../../errors/domain-error";
import { outboundFetch, type OutboundFetch, OutboundError } from "../../http/outbound";

const METADATA_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";

/** The plugin's own ceiling, so nothing saved here is refused when it is read back. */
export const MAX_IDP_METADATA_BYTES = 100 * 1024;

export type IdpMetadata = {
  entityId: string;
  ssoUrl: string;
  /** Base64 DER, as the metadata carries them. */
  signingCertificates: string[];
};

function invalid(): never {
  throw domainError("samlMetadataInvalid", {}, { status: 400 });
}

function children(parent: XmlElement, namespace: string, localName: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    const element = node as XmlElement;
    if (
      node.nodeType === 1 &&
      element.localName === localName &&
      element.namespaceURI === namespace
    )
      found.push(element);
  }
  return found;
}

function signingCertificates(descriptor: XmlElement): string[] {
  const certificates: string[] = [];
  for (const key of children(descriptor, METADATA_NS, "KeyDescriptor")) {
    // No `use` means the key serves both purposes.
    const use = key.getAttribute("use");
    if (use && use !== "signing") continue;
    for (const info of children(key, DSIG_NS, "KeyInfo")) {
      for (const data of children(info, DSIG_NS, "X509Data")) {
        for (const cert of children(data, DSIG_NS, "X509Certificate")) {
          const value = (cert.textContent ?? "").replace(/\s+/g, "");
          if (value) certificates.push(value);
        }
      }
    }
  }
  return certificates;
}

export function readIdpMetadata(xml: string): IdpMetadata {
  const text = xml.trim();
  if (!text) throw domainError("samlMetadataRequired", {}, { status: 400 });
  if (new TextEncoder().encode(text).length > MAX_IDP_METADATA_BYTES) {
    throw domainError(
      "samlMetadataTooLarge",
      { kib: MAX_IDP_METADATA_BYTES / 1024 },
      { status: 400 },
    );
  }
  // Metadata never needs one, and an entity declaration is how XML bombs and file reads start.
  if (/<!DOCTYPE/i.test(text)) invalid();

  let root: XmlElement | null = null;
  try {
    // Cast: samlify's xmldom 0.8 declares the same module, and its options type has no onError.
    const options = {
      onError: (level: string) => {
        if (level !== "warning") throw new Error("unparseable");
      },
    } as unknown as ConstructorParameters<typeof DOMParser>[0];
    const document = new DOMParser(options).parseFromString(text, "text/xml");
    root = document.documentElement as XmlElement | null;
  } catch {
    invalid();
  }
  if (!root || root.namespaceURI !== METADATA_NS) invalid();
  if (root.localName === "EntitiesDescriptor") {
    throw domainError("samlMetadataManyEntities", {}, { status: 400 });
  }
  if (root.localName !== "EntityDescriptor") invalid();

  const entityId = root.getAttribute("entityID")?.trim();
  if (!entityId) invalid();
  const [descriptor] = children(root, METADATA_NS, "IDPSSODescriptor");
  if (!descriptor) throw domainError("samlMetadataNotIdp", {}, { status: 400 });

  const ssoUrl = children(descriptor, METADATA_NS, "SingleSignOnService")
    .find((service) => service.getAttribute("Binding") === REDIRECT_BINDING)
    ?.getAttribute("Location")
    ?.trim();
  if (!ssoUrl || !/^https?:\/\//i.test(ssoUrl)) {
    throw domainError("samlMetadataNoRedirectBinding", {}, { status: 400 });
  }

  const certificates = signingCertificates(descriptor);
  if (certificates.length === 0) {
    throw domainError("samlMetadataNoSigningCertificate", {}, { status: 400 });
  }
  return { entityId, ssoUrl, signingCertificates: certificates };
}

const WANTS_SIGNED_REQUESTS =
  /(<(?:[\w.-]+:)?IDPSSODescriptor\b[^>]*?\bWantAuthnRequestsSigned\s*=\s*)(["'])(?:true|1)\2/;

/**
 * The plugin refuses to sign in at all against metadata asking for signed requests, which
 * Keycloak's realm descriptor always does. CPM never signs them, so the IdP's own client
 * setting decides: one that requires a signature turns the request away on its side.
 */
export function withUnsignedRequests(xml: string): string {
  return xml.replace(WANTS_SIGNED_REQUESTS, "$1$2false$2");
}

/** Fetched when the provider is saved, never at sign-in: the stored copy is what is trusted. */
export async function fetchIdpMetadata(
  url: string,
  fetcher: OutboundFetch = outboundFetch,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw domainError("samlMetadataUrlInvalid", {}, { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw domainError("samlMetadataUrlInvalid", {}, { status: 400 });
  }
  let response: Response;
  try {
    // outbound: samlMetadata
    response = await fetcher(parsed, {
      headers: { Accept: "application/samlmetadata+xml, application/xml, text/xml" },
      maxResponseBytes: MAX_IDP_METADATA_BYTES,
      timeoutMs: 15_000,
    });
  } catch (error) {
    const reason = error instanceof OutboundError ? error.code : "network";
    throw domainError("samlMetadataFetchFailed", { reason }, { status: 400 });
  }
  if (!response.ok) {
    throw domainError(
      "samlMetadataFetchFailed",
      { reason: String(response.status) },
      { status: 400 },
    );
  }
  return await response.text();
}
