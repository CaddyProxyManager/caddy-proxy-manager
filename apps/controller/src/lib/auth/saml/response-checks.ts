/**
 * Two checks the plugin leaves undone for a POSTed response, found by
 * `tests/integration/auth/saml-assertions.test.ts`: it only sees the algorithm of a redirect-bound
 * signature, so SHA-1 in the XML passes; and its replay marker needs a string primary key on the
 * verifications table, where CPM's ids are serial, so the marker never collides. Read before the
 * plugin verifies anything; the plugin still refuses whatever these let through.
 */
import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";

const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";

export const ALLOWED_SIGNATURE_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512",
]);

export const ALLOWED_DIGEST_ALGORITHMS = new Set([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmldsig-more#sha384",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);

/** How long a used assertion is remembered when it names no end of its own. */
const DEFAULT_REMEMBER_MS = 60 * 60 * 1000;
const MAX_REMEMBER_MS = 24 * 60 * 60 * 1000;

export type ResponseFacts = {
  /** Every signature uses an algorithm on the lists above. */
  strongAlgorithms: boolean;
  /** The sole assertion's ID; null with none or several, which the plugin refuses itself. */
  assertionId: string | null;
  /** Until when a replay of it must be refused: its NotOnOrAfter plus the skew, capped. */
  rememberUntil: number;
};

type Searchable = {
  getElementsByTagNameNS(namespace: string, localName: string): ArrayLike<unknown>;
};

function elements(scope: Searchable, namespace: string, localName: string): XmlElement[] {
  return Array.from(scope.getElementsByTagNameNS(namespace, localName)) as XmlElement[];
}

function algorithms(scope: Searchable, localName: string): string[] {
  return elements(scope, DSIG_NS, localName).map((node) => node.getAttribute("Algorithm") ?? "");
}

/** Null when it is not XML at all; the plugin answers that with its own refusal. */
export function readResponseFacts(
  encoded: unknown,
  clockSkewMs: number,
  now = Date.now(),
): ResponseFacts | null {
  if (typeof encoded !== "string" || !encoded) return null;
  let xml: string;
  try {
    xml = Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
  if (!xml.includes("<")) return null;
  let document: ReturnType<DOMParser["parseFromString"]>;
  try {
    // Cast: see auth/saml/metadata.ts.
    const options = {
      onError: (level: string) => {
        if (level !== "warning") throw new Error("unparseable");
      },
    } as unknown as ConstructorParameters<typeof DOMParser>[0];
    document = new DOMParser(options).parseFromString(xml, "text/xml");
  } catch {
    return null;
  }

  const signatureAlgorithms = algorithms(document, "SignatureMethod");
  const digestAlgorithms = algorithms(document, "DigestMethod");
  const strongAlgorithms =
    signatureAlgorithms.every((uri) => ALLOWED_SIGNATURE_ALGORITHMS.has(uri)) &&
    digestAlgorithms.every((uri) => ALLOWED_DIGEST_ALGORITHMS.has(uri));

  const assertions = elements(document, ASSERTION_NS, "Assertion");
  const assertion = assertions.length === 1 ? assertions[0] : null;
  const assertionId = assertion?.getAttribute("ID") || null;

  const conditions = assertion ? elements(assertion, ASSERTION_NS, "Conditions")[0] : undefined;
  const notOnOrAfter = Date.parse(conditions?.getAttribute("NotOnOrAfter") ?? "");
  const rememberUntil = Number.isFinite(notOnOrAfter)
    ? Math.min(notOnOrAfter + clockSkewMs, now + MAX_REMEMBER_MS)
    : now + DEFAULT_REMEMBER_MS;
  return {
    strongAlgorithms,
    assertionId,
    rememberUntil: Math.max(rememberUntil, now + clockSkewMs),
  };
}
