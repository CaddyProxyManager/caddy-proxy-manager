/**
 * A real OIDC provider, so the fast suites reach the queries Better Auth builds only in a callback.
 * `interactiveLogin: false` makes a sign-in three fetches. Start it with:
 *
 *   docker run -d --name cpm-idp -p 5599:8080 \
 *     -e JSON_CONFIG='<the JSON printed by `bun tests/helpers/mock-idp.ts`>' \
 *     ghcr.io/navikt/mock-oauth2-server:2.1.10
 *
 * JSON_CONFIG, not a bind mount: that silently fails on Windows and the login hangs on a form.
 */

/** TEST_OIDC_URL lets CI point at a service container. */
export const MOCK_IDP_URL = (process.env.TEST_OIDC_URL ?? 'http://localhost:5599').replace(
  /\/$/,
  '',
);

/** The "default" realm, which the app is configured with. */
export const MOCK_IDP_ISSUER = `${MOCK_IDP_URL}/default`;

/** Claims the IdP returns. `role: "admin"` is deliberate - see oauth-flow.test.ts. */
export const MOCK_IDP_CLAIMS = {
  sub: 'test-oauth-user',
  email: 'oauth@test.local',
  email_verified: true,
  name: 'Test OAuth User',
  role: 'admin',
} as const;

/** One definition for the docs above, CI and local runs. */
export const MOCK_IDP_JSON_CONFIG = JSON.stringify({
  interactiveLogin: false,
  httpServer: 'NettyWrapper',
  tokenCallbacks: [
    {
      issuerId: 'default',
      requestMappings: [
        { requestParam: 'grant_type', match: 'authorization_code', claims: MOCK_IDP_CLAIMS },
      ],
    },
  ],
});

/** So a suite can skip rather than fail when nobody started it. */
export async function isMockIdpReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${MOCK_IDP_ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type OAuthSignInResult = {
  /** Where the app redirected after the callback. Contains "error" when sign-in failed. */
  location: string;
  ok: boolean;
  /** Ready to replay on a later request. */
  cookie: string;
};

/** Calls `auth.handler` directly: nothing need listen on BASE_URL, only redirect_uri must match. */
export async function completeOAuthSignIn(
  auth: any,
  options: { providerId: string; baseUrl?: string },
): Promise<OAuthSignInResult> {
  const base = (options.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  const cookies = new Map<string, string>();

  const absorb = (response: Response) => {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

  // Better Auth 1.7+ registers generic-OAuth providers as social; /sign-in/oauth2 404s.
  const startResponse = await auth.handler(
    new Request(`${base}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ provider: options.providerId, callbackURL: '/' }),
    }),
  );
  absorb(startResponse);
  const startBody = (await startResponse.json().catch(() => ({}))) as { url?: string };
  if (!startBody.url) {
    throw new Error(
      `OAuth start failed: HTTP ${startResponse.status} ${JSON.stringify(startBody)}`,
    );
  }

  // interactiveLogin:false means /authorize answers with the redirect itself.
  const idpResponse = await fetch(startBody.url, { redirect: 'manual' });
  const callbackUrl = idpResponse.headers.get('location');
  if (!callbackUrl) {
    throw new Error(
      `IdP did not redirect (HTTP ${idpResponse.status}) - it is probably running with ` +
        `interactiveLogin enabled, which serves an HTML login form instead.`,
    );
  }

  const callbackResponse = await auth.handler(
    new Request(callbackUrl, { headers: { cookie: cookieHeader() }, redirect: 'manual' }),
  );
  absorb(callbackResponse);
  const location = callbackResponse.headers.get('location') ?? '';

  return { location, ok: location !== '' && !location.includes('error'), cookie: cookieHeader() };
}

// Prints the config for the docker command above.
if (import.meta.main) {
  console.log(MOCK_IDP_JSON_CONFIG);
}
