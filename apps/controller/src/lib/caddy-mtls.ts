/** mTLS helpers for Caddy TLS connection policies and HTTP-layer RBAC routes. */

/** Caddy's form: Node gives "AB:CD:EF:..." and Caddy's placeholder "abcdef...". */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/:/g, "").toLowerCase();
}

/** Redeclared: importing models pulls in db.ts. */
export type MtlsAccessRuleLike = {
  pathPattern: string;
  allowedRoleIds: number[];
  allowedCertIds: number[];
  denyAll: boolean;
};

/** Base64 DER, the form `trusted_ca_certs` and `trusted_leaf_certs` expect. */
export function pemToBase64Der(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
}

/**
 * Unions the domains' CA ids, so callers pre-group them (`groupMtlsDomainsByCaSet`). No leaf pins
 * under `verify_if_given`: Caddy's leaf verifier fails a certless handshake, locking clients out
 * of open paths; the HTTP gate pins fingerprints instead.
 */
export function buildClientAuthentication(
  domains: string[],
  mTlsDomainMap: Map<string, number[]>,
  caCertMap: Map<number, { id: number; certificatePem: string }>,
  issuedClientCertMap: Map<number, string[]>,
  cAsWithAnyIssuedCerts: Set<number>,
  mTlsDomainLeafOverride?: Map<string, string[]>,
  mode: "require_and_verify" | "verify_if_given" = "require_and_verify",
): Record<string, unknown> | null {
  const caCertIds = new Set<number>();
  for (const domain of domains) {
    const ids = mTlsDomainMap.get(domain.toLowerCase());
    if (ids) {
      for (const id of ids) caCertIds.add(id);
    }
  }
  if (caCertIds.size === 0) return null;

  // Any domain on the cert-based model (a leaf override).
  const leafOverridePems = new Set<string>();
  let hasLeafOverride = false;
  if (mTlsDomainLeafOverride) {
    for (const domain of domains) {
      const pems = mTlsDomainLeafOverride.get(domain.toLowerCase());
      if (pems) {
        hasLeafOverride = true;
        for (const pem of pems) leafOverridePems.add(pem);
      }
    }
  }

  const trustedCaCerts: string[] = [];
  const trustedLeafCerts: string[] = [];

  if (hasLeafOverride) {
    // Cert-based: the CAs validate the chain, the selected leaves are pinned.
    for (const id of caCertIds) {
      const ca = caCertMap.get(id);
      if (ca) trustedCaCerts.push(pemToBase64Der(ca.certificatePem));
    }
    for (const pem of leafOverridePems) {
      trustedLeafCerts.push(pemToBase64Der(pem));
    }
  } else {
    for (const id of caCertIds) {
      const ca = caCertMap.get(id);
      if (!ca) continue;

      if (cAsWithAnyIssuedCerts.has(id)) {
        const activeLeafCerts = issuedClientCertMap.get(id) ?? [];
        trustedCaCerts.push(pemToBase64Der(ca.certificatePem));
        if (activeLeafCerts.length === 0) {
          // All certs revoked - pin the CA cert itself as a leaf. No client cert can hash-match a
          // CA cert, so this rejects everyone while keeping a valid client_authentication block.
          trustedLeafCerts.push(pemToBase64Der(ca.certificatePem));
        } else {
          for (const certPem of activeLeafCerts) {
            trustedLeafCerts.push(pemToBase64Der(certPem));
          }
        }
      } else {
        trustedCaCerts.push(pemToBase64Der(ca.certificatePem));
      }
    }
  }

  if (trustedCaCerts.length === 0) return null;

  const result: Record<string, unknown> = {
    mode,
    trusted_ca_certs: trustedCaCerts,
  };
  if (trustedLeafCerts.length > 0 && mode === "require_and_verify") {
    result.trusted_leaf_certs = trustedLeafCerts;
  }
  return result;
}

export function buildValidClientCertCelExpression(): string {
  return "{http.request.tls.client.fingerprint} != ''";
}

/** An unparseable expiry counts as expired, so bad data narrows trust rather than widening it. */
export function isCertificateUnexpired(validTo: string, now = Date.now()): boolean {
  const expiry = Date.parse(validTo);
  return Number.isFinite(expiry) && expiry > now;
}

/**
 * Null admits any TLS-verified cert. Mirrors buildClientAuthentication's `trusted_leaf_certs`,
 * which path-scoped hosts cannot carry at the TLS layer.
 */
export function resolveLegacyCaFingerprints(
  caIds: number[],
  caFingerprintMap: Map<number, Set<string>>,
  managedCaIds: Set<number>,
): Set<string> | null {
  if (!caIds.some((id) => managedCaIds.has(id))) return null;
  const allowed = new Set<string>();
  for (const id of caIds) {
    for (const fp of caFingerprintMap.get(id) ?? []) allowed.add(fp);
  }
  return allowed;
}

/**
 * One TLS policy per CA set, so a cert from CA_B cannot authenticate to a host that chose CA_A.
 * The pinned leaves are part of the key too: buildClientAuthentication unions the leaves of every
 * domain it is given, so hosts pinning different certs from one CA must not share a policy.
 */
export function groupMtlsDomainsByCaSet(
  domains: string[],
  mTlsDomainMap: Map<string, number[]>,
  mTlsDomainLeafOverride?: Map<string, string[]>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const domain of domains) {
    const ids = mTlsDomainMap.get(domain.toLowerCase()) ?? [];
    const caKey = [...ids].sort((a, b) => a - b).join(",");
    const leafPems = mTlsDomainLeafOverride?.get(domain.toLowerCase());
    const key = leafPems
      ? `${caKey}|leaf:${[...new Set(leafPems.map((pem) => pem.trim()))].sort().join("\n")}`
      : caKey;
    const group = groups.get(key) ?? [];
    group.push(domain);
    groups.set(key, group);
  }
  return groups;
}

// ── mTLS RBAC HTTP-layer route enforcement ───────────────────────────

export function resolveAllowedFingerprints(
  rule: MtlsAccessRuleLike,
  roleFingerprintMap: Map<number, Set<string>>,
  certFingerprintMap: Map<number, string>,
): Set<string> {
  const allowed = new Set<string>();

  for (const roleId of rule.allowedRoleIds) {
    const fps = roleFingerprintMap.get(roleId);
    if (fps) {
      for (const fp of fps) allowed.add(fp);
    }
  }

  for (const certId of rule.allowedCertIds) {
    const fp = certFingerprintMap.get(certId);
    if (fp) allowed.add(fp);
  }

  return allowed;
}

export function buildFingerprintCelExpression(fingerprints: Set<string>): string {
  const fps = Array.from(fingerprints).sort();
  const quoted = fps.map((fp) => `'${fp}'`).join(", ");
  return `{http.request.tls.client.fingerprint} in [${quoted}]`;
}

/** Per rule an allow route then a path-only 403; the catch-all admits any valid cert. */
export function buildMtlsRbacSubroutes(
  accessRules: MtlsAccessRuleLike[],
  roleFingerprintMap: Map<number, Set<string>>,
  certFingerprintMap: Map<number, string>,
  baseHandlers: Record<string, unknown>[],
  reverseProxyHandler: Record<string, unknown>,
  requireValidClientCertByDefault = false,
  defaultAllowedFingerprints?: Set<string>,
): Record<string, unknown>[] | null {
  if (accessRules.length === 0) return null;

  const subroutes: Record<string, unknown>[] = [];

  // Rules are already sorted by priority desc, path asc
  for (const rule of accessRules) {
    if (rule.denyAll) {
      subroutes.push({
        match: [{ path: [rule.pathPattern] }],
        handle: [
          {
            handler: "static_response",
            status_code: "403",
            body: "mTLS access denied",
          },
        ],
        terminal: true,
      });
      continue;
    }

    const allowedFps = resolveAllowedFingerprints(rule, roleFingerprintMap, certFingerprintMap);

    if (allowedFps.size === 0) {
      // No certs match: deny the path.
      subroutes.push({
        match: [{ path: [rule.pathPattern] }],
        handle: [
          {
            handler: "static_response",
            status_code: "403",
            body: "mTLS access denied",
          },
        ],
        terminal: true,
      });
      continue;
    }

    const celExpr = buildFingerprintCelExpression(allowedFps);
    subroutes.push({
      match: [{ path: [rule.pathPattern], expression: celExpr }],
      handle: [...baseHandlers, reverseProxyHandler],
      terminal: true,
    });

    subroutes.push({
      match: [{ path: [rule.pathPattern] }],
      handle: [
        {
          handler: "static_response",
          status_code: "403",
          body: "mTLS access denied",
        },
      ],
      terminal: true,
    });
  }

  if (requireValidClientCertByDefault) {
    // An empty set denies: a host pinned to certs that are all revoked or expired must not fall
    // back to "any verified cert". Undefined is what means unpinned.
    const defaultExpression = defaultAllowedFingerprints
      ? buildFingerprintCelExpression(defaultAllowedFingerprints)
      : buildValidClientCertCelExpression();

    subroutes.push({
      match: [{ expression: defaultExpression }],
      handle: [...baseHandlers, reverseProxyHandler],
      terminal: true,
    });
    subroutes.push({
      handle: [
        {
          handler: "static_response",
          status_code: "403",
          body: "mTLS access denied",
        },
      ],
      terminal: true,
    });
  } else {
    subroutes.push({
      handle: [...baseHandlers, reverseProxyHandler],
      terminal: true,
    });
  }

  return subroutes;
}
