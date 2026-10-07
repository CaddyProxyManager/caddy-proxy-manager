/** What an identity provider is told about CPM. No server imports: the Settings form shows them. */

export const SAML_PROVIDER_TYPE = "saml";

/** The key the groups attribute is copied to in the plugin's user info (`mapping.extraFields`). */
export const SAML_GROUPS_FIELD = "groups";

function base(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/auth`;
}

/** Where the identity provider posts its response. */
export function samlAcsUrl(baseUrl: string, providerId: string): string {
  return `${base(baseUrl)}/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`;
}

export function samlSpMetadataUrl(baseUrl: string, providerId: string): string {
  return `${base(baseUrl)}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
}

/** The metadata URL, as most identity providers expect; an administrator may type another. */
export function defaultSpEntityId(baseUrl: string, providerId: string): string {
  return samlSpMetadataUrl(baseUrl, providerId);
}
