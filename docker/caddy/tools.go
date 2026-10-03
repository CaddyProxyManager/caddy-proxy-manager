// Version pins for xcaddy; nothing here ships. The blank imports, untagged and in sync with
// build.sh, stop Dependabot's `go mod tidy` stripping go.mod's requires and give CodeQL a package.
// xcaddy is a `tool` directive (a main package cannot be imported); cel-go is absent (no root
// package) and pinned by go.mod's replace.

package tools

import (
	_ "github.com/caddy-dns/acmedns"
	_ "github.com/caddy-dns/cloudflare"
	_ "github.com/caddy-dns/cloudns"
	_ "github.com/caddy-dns/desec"
	_ "github.com/caddy-dns/digitalocean"
	_ "github.com/caddy-dns/duckdns"
	_ "github.com/caddy-dns/dynu"
	_ "github.com/caddy-dns/godaddy"
	_ "github.com/caddy-dns/hetzner"
	_ "github.com/caddy-dns/infomaniak"
	_ "github.com/caddy-dns/ionos"
	_ "github.com/caddy-dns/linode"
	_ "github.com/caddy-dns/namecheap"
	_ "github.com/caddy-dns/netcup"
	_ "github.com/caddy-dns/njalla"
	_ "github.com/caddy-dns/ovh"
	_ "github.com/caddy-dns/porkbun"
	_ "github.com/caddy-dns/rfc2136"
	_ "github.com/caddy-dns/route53"
	_ "github.com/caddy-dns/spaceship"
	_ "github.com/caddy-dns/vultr"
	_ "github.com/caddyserver/cache-handler"
	_ "github.com/caddyserver/caddy/v2"
	_ "github.com/corazawaf/coraza-caddy/v2"
	_ "github.com/darkweak/storages/badger/caddy"
	_ "github.com/darkweak/storages/etcd/caddy"
	_ "github.com/darkweak/storages/otter/caddy"
	_ "github.com/darkweak/storages/redis/caddy"
	_ "github.com/darkweak/storages/simplefs/caddy"
	_ "github.com/fuomag9/caddy-blocker-plugin"
	_ "github.com/hslatman/caddy-crowdsec-bouncer"
	_ "github.com/mholt/caddy-l4"
	_ "github.com/mholt/caddy-ratelimit"
	_ "github.com/tailscale/caddy-tailscale"
)
