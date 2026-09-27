/**
 * The `--with` specs `docker/caddy/Dockerfile` compiles in by default. Shared because both sides
 * assume a never-rebuilt agent carries exactly these. The catalog and the ARG are tested against it.
 */
export const SHIPPED_CADDY_MODULES: readonly string[] = [
  "github.com/caddy-dns/cloudflare",
  "github.com/caddy-dns/route53",
  "github.com/caddy-dns/digitalocean",
  "github.com/caddy-dns/duckdns",
  "github.com/caddy-dns/hetzner",
  "github.com/caddy-dns/vultr",
  "github.com/caddy-dns/porkbun",
  "github.com/caddy-dns/godaddy",
  "github.com/caddy-dns/namecheap",
  "github.com/caddy-dns/netcup",
  "github.com/caddy-dns/ovh",
  "github.com/caddy-dns/ionos",
  "github.com/caddy-dns/linode",
  "github.com/caddy-dns/njalla",
  "github.com/caddy-dns/spaceship",
  "github.com/caddy-dns/desec",
  "github.com/caddy-dns/dynu",
  "github.com/caddy-dns/acmedns",
  "github.com/caddy-dns/infomaniak",
  "github.com/caddy-dns/cloudns",
  "github.com/caddy-dns/rfc2136",
  "github.com/mholt/caddy-l4",
  "github.com/tailscale/caddy-tailscale",
  "github.com/fuomag9/caddy-blocker-plugin",
  "github.com/corazawaf/coraza-caddy/v2",
];
