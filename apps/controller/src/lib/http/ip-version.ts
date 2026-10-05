import { isIP } from "node:net";

/** `isIP` without IPv6 zone ids: `fe80::1%eth0` names an interface, which Caddy's ranges refuse. */
export function ipVersion(text: string): 0 | 4 | 6 {
  return text.includes("%") ? 0 : (isIP(text) as 0 | 4 | 6);
}
