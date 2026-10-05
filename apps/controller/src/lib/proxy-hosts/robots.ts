/**
 * "Discourage search engines" for a proxy host. Both handlers sit before path blocks, access lists
 * and auth, so a crawler gets the answer without signing in.
 */

export const ROBOTS_TXT_DISALLOW_ALL = "User-agent: *\nDisallow: /\n";

export function buildNoIndexHandlers(): Record<string, unknown>[] {
  return [
    // Deferred, so it replaces an upstream's own X-Robots-Tag rather than being overwritten by it.
    {
      handler: "headers",
      response: { set: { "X-Robots-Tag": ["noindex, nofollow"] }, deferred: true },
    },
    {
      handler: "subroute",
      routes: [
        {
          match: [{ path: ["/robots.txt"] }],
          handle: [
            {
              handler: "static_response",
              status_code: 200,
              headers: { "Content-Type": ["text/plain; charset=utf-8"] },
              body: ROBOTS_TXT_DISALLOW_ALL,
            },
          ],
        },
      ],
    },
  ];
}
