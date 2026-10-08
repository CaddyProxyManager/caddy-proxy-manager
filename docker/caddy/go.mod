// Version catalog for the Caddy build. Nothing here is compiled as a Go program: docker/caddy/
// build.sh reads these pins with `go list -m` and turns them into `xcaddy build --with path@version`
// flags, so a rebuild a month from now produces the same binary and go.sum authenticates each
// module. Which of them are compiled in is a separate question, answered at build time by
// CADDY_MODULES (Settings -> Caddy Build). Every module in src/lib/caddy-modules.ts must appear
// here - tests/unit/caddy-modules.test.ts asserts that.
//
// tools.go is what makes this survive `go mod tidy`: nothing here ships, so without its blank
// imports tidy considers every requirement unused and empties the block. Dependabot runs tidy, so
// deleting that file turns each dependency PR into a go.mod wipe. Its imports are deliberately
// untagged, which also gives CodeQL a buildable package to analyse.
//
// xcaddy itself is deliberately absent - it comes from the caddy:<version>-builder image the
// Dockerfile pins, not from here, so there is only one place its version lives.

module github.com/ingres-si/caddy-proxy-manager/docker/caddy

go 1.27.1

require (
	github.com/caddy-dns/acmedns v0.7.0
	github.com/caddy-dns/cloudflare v0.2.4
	github.com/caddy-dns/cloudns v1.2.0
	github.com/caddy-dns/desec v1.1.0
	github.com/caddy-dns/digitalocean v0.0.0-20250606074528-04bde2867106
	github.com/caddy-dns/duckdns v0.5.0
	github.com/caddy-dns/dynu v1.0.0
	github.com/caddy-dns/godaddy v1.2.0
	github.com/caddy-dns/hetzner/v2 v2.0.1
	github.com/caddy-dns/infomaniak v1.0.2
	github.com/caddy-dns/inwx v0.4.1
	github.com/caddy-dns/ionos v1.2.0
	github.com/caddy-dns/linode v0.8.0
	github.com/caddy-dns/namecheap v1.0.0
	github.com/caddy-dns/netcup v1.0.0
	github.com/caddy-dns/njalla v1.0.0
	github.com/caddy-dns/ovh v1.1.0
	github.com/caddy-dns/porkbun v0.3.1
	github.com/caddy-dns/rfc2136 v1.0.0
	github.com/caddy-dns/route53 v1.6.2
	github.com/caddy-dns/spaceship v1.0.0
	github.com/caddy-dns/vultr v0.0.0-20250723121531-55bf3e9768be
	github.com/caddyserver/cache-handler v0.17.0
	github.com/caddyserver/caddy/v2 v2.11.7
	github.com/corazawaf/coraza-caddy/v2 v2.6.1
	github.com/darkweak/storages/badger/caddy v0.0.20
	github.com/darkweak/storages/etcd/caddy v0.0.20
	github.com/darkweak/storages/otter/caddy v0.0.20
	github.com/darkweak/storages/redis/caddy v0.0.20
	github.com/darkweak/storages/simplefs/caddy v0.0.20
	github.com/fuomag9/caddy-blocker-plugin v0.0.0-20260910060514-71474a863f65
	github.com/hslatman/caddy-crowdsec-bouncer v0.14.1
	github.com/mholt/caddy-l4 v0.1.2
	github.com/mholt/caddy-ratelimit v0.1.1-0.20260612195517-5625512f24f6
	github.com/tailscale/caddy-tailscale v0.0.0-20260826180304-de41b249af4f
)

require (
	cel.dev/cel-go v0.32.0 // indirect
	cel.dev/expr v0.25.3 // indirect
	cloud.google.com/go/auth v0.23.3 // indirect
	cloud.google.com/go/auth/oauth2adapt v0.2.8 // indirect
	cloud.google.com/go/compute/metadata v0.9.1 // indirect
	dario.cat/mergo v1.0.2 // indirect
	filippo.io/bigmod v0.1.0 // indirect
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/AndreasBriese/bbloom v0.0.0-20190825152654-46b345b51c96 // indirect
	github.com/KimMachineGun/automemlimit v1.0.0 // indirect
	github.com/Masterminds/goutils v1.1.1 // indirect
	github.com/Masterminds/semver/v3 v3.5.0 // indirect
	github.com/Masterminds/sprig/v3 v3.3.0 // indirect
	github.com/akutz/memconn v0.1.0 // indirect
	github.com/alexbrainman/sspi v0.0.0-20250919150558-7d374ff0d59e // indirect
	github.com/antlr4-go/antlr/v4 v4.13.1 // indirect
	github.com/aryann/difflib v0.0.0-20210328193216-ff5ff6dc229b // indirect
	github.com/aws/aws-sdk-go-v2 v1.47.0 // indirect
	github.com/aws/aws-sdk-go-v2/config v1.33.4 // indirect
	github.com/aws/aws-sdk-go-v2/credentials v1.20.4 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.20.0 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.5.3 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.8.3 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.5.3 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.19 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.14.3 // indirect
	github.com/aws/aws-sdk-go-v2/service/route53 v1.58.5 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.10.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.38.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.43.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/sts v1.50.0 // indirect
	github.com/aws/smithy-go v1.28.2 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/bits-and-blooms/bitset v1.25.0 // indirect
	github.com/boombuler/barcode v1.0.2 // indirect
	github.com/caddyserver/certmagic v0.25.6 // indirect
	github.com/caddyserver/zerossl v0.1.6 // indirect
	github.com/ccoveille/go-safecast/v2 v2.0.1 // indirect
	github.com/cenkalti/backoff/v4 v4.3.0 // indirect
	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
	github.com/cespare/xxhash v1.1.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/chzyer/readline v1.5.1 // indirect
	github.com/cloudflare/circl v1.6.5 // indirect
	github.com/coder/websocket v1.8.15 // indirect
	github.com/corazawaf/coraza-coreruleset/v4 v4.25.0 // indirect
	github.com/corazawaf/coraza/v3 v3.8.1 // indirect
	github.com/corazawaf/libinjection-go v0.3.3 // indirect
	github.com/coreos/go-oidc/v3 v3.21.0 // indirect
	github.com/coreos/go-semver v0.3.0 // indirect
	github.com/coreos/go-systemd/v22 v22.7.0 // indirect
	github.com/cpuguy83/go-md2man/v2 v2.0.7 // indirect
	github.com/creachadair/msync v0.8.4 // indirect
	github.com/crowdsecurity/crowdsec v1.7.8 // indirect
	github.com/crowdsecurity/go-cs-lib v0.0.25 // indirect
	github.com/darkweak/souin v1.7.9 // indirect
	github.com/darkweak/storages/badger v0.0.19 // indirect
	github.com/darkweak/storages/core v0.0.20 // indirect
	github.com/darkweak/storages/etcd v0.0.19 // indirect
	github.com/darkweak/storages/otter v0.0.19 // indirect
	github.com/darkweak/storages/redis v0.0.19 // indirect
	github.com/darkweak/storages/simplefs v0.0.19 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/dblohm7/wingoes v0.0.0-20260526185140-fb298caac7ca // indirect
	github.com/dgraph-io/badger v1.6.2 // indirect
	github.com/dgraph-io/badger/v2 v2.2007.4 // indirect
	github.com/dgraph-io/badger/v4 v4.9.1 // indirect
	github.com/dgraph-io/ristretto v0.2.0 // indirect
	github.com/dgraph-io/ristretto/v2 v2.2.0 // indirect
	github.com/dgryski/go-farm v0.0.0-20240924180020-3414d57e47da // indirect
	github.com/digitalocean/godo v1.148.0 // indirect
	github.com/dolthub/maphash v0.1.0 // indirect
	github.com/dunglas/go-urlpattern v1.0.0 // indirect
	github.com/dunglas/httpsfv v1.1.1 // indirect
	github.com/dustin/go-humanize v1.1.0 // indirect
	github.com/ebitengine/purego v0.10.0 // indirect
	github.com/felixge/httpsnoop v1.1.0 // indirect
	github.com/fsnotify/fsnotify v1.10.1 // indirect
	github.com/fxamacker/cbor/v2 v2.9.4 // indirect
	github.com/gaissmai/bart v0.28.0 // indirect
	github.com/gammazero/deque v0.2.1 // indirect
	github.com/go-jose/go-jose/v3 v3.0.5 // indirect
	github.com/go-jose/go-jose/v4 v4.1.5 // indirect
	github.com/go-json-experiment/json v0.0.0-20260820222146-c27c302e5fc3 // indirect
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/go-openapi/analysis v0.25.5 // indirect
	github.com/go-openapi/errors v0.22.8 // indirect
	github.com/go-openapi/jsonpointer v1.0.0 // indirect
	github.com/go-openapi/jsonreference v1.0.0 // indirect
	github.com/go-openapi/loads v0.25.0 // indirect
	github.com/go-openapi/spec v0.22.9 // indirect
	github.com/go-openapi/strfmt v0.27.0 // indirect
	github.com/go-openapi/swag v0.28.0 // indirect
	github.com/go-openapi/swag/cmdutils v0.28.0 // indirect
	github.com/go-openapi/swag/conv v0.28.0 // indirect
	github.com/go-openapi/swag/fileutils v0.28.0 // indirect
	github.com/go-openapi/swag/jsonutils v0.28.0 // indirect
	github.com/go-openapi/swag/loading v0.28.0 // indirect
	github.com/go-openapi/swag/mangling v0.28.0 // indirect
	github.com/go-openapi/swag/netutils v0.28.0 // indirect
	github.com/go-openapi/swag/pools v0.28.0 // indirect
	github.com/go-openapi/swag/stringutils v0.28.0 // indirect
	github.com/go-openapi/swag/typeutils v0.28.0 // indirect
	github.com/go-openapi/swag/yamlutils v0.28.0 // indirect
	github.com/go-openapi/validate v0.26.1 // indirect
	github.com/go-resty/resty/v2 v2.16.5 // indirect
	github.com/go-sql-driver/mysql v1.10.1 // indirect
	github.com/go-viper/mapstructure/v2 v2.5.0 // indirect
	github.com/goccy/go-yaml v1.19.2 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/gogo/protobuf v1.3.2 // indirect
	github.com/golang-jwt/jwt/v4 v4.5.2 // indirect
	github.com/golang/groupcache v0.0.0-20241129210726-2c02b8208cf8 // indirect
	github.com/golang/protobuf v1.5.4 // indirect
	github.com/golang/snappy v1.0.0 // indirect
	github.com/google/btree v1.1.3 // indirect
	github.com/google/flatbuffers v25.2.10+incompatible // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/google/go-querystring v1.2.0 // indirect
	github.com/google/s2a-go v0.1.10 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/googleapis/enterprise-certificate-proxy v0.3.22 // indirect
	github.com/googleapis/gax-go/v2 v2.25.0 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.30.0 // indirect
	github.com/hashicorp/go-cleanhttp v0.5.2 // indirect
	github.com/hashicorp/go-retryablehttp v0.7.8 // indirect
	github.com/hdevalence/ed25519consensus v0.2.0 // indirect
	github.com/hetznercloud/hcloud-go/v2 v2.37.0 // indirect
	github.com/hslatman/ipstore v0.5.0 // indirect
	github.com/huandu/xstrings v1.6.1 // indirect
	github.com/huin/goupnp v1.3.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/pgx/v5 v5.11.0 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/jcchavezs/mergefs v0.1.1 // indirect
	github.com/jellydator/ttlcache/v3 v3.3.0 // indirect
	github.com/jsimonetti/rtnetlink v1.4.2 // indirect
	github.com/kaptinlin/go-i18n v0.3.1 // indirect
	github.com/kaptinlin/jsonpointer v0.4.17 // indirect
	github.com/kaptinlin/jsonschema v0.7.7 // indirect
	github.com/kaptinlin/messageformat-go v0.4.20 // indirect
	github.com/klauspost/compress v1.20.1 // indirect
	github.com/klauspost/cpuid/v2 v2.4.0 // indirect
	github.com/libdns/acmedns v0.5.0 // indirect
	github.com/libdns/cloudflare v0.2.2 // indirect
	github.com/libdns/cloudns v1.2.0 // indirect
	github.com/libdns/desec v1.1.1 // indirect
	github.com/libdns/digitalocean v0.0.0-20250606071607-dfa7af5c2e31 // indirect
	github.com/libdns/duckdns v0.3.0 // indirect
	github.com/libdns/dynu v1.0.0 // indirect
	github.com/libdns/godaddy v1.1.0 // indirect
	github.com/libdns/hetzner/v2 v2.0.1 // indirect
	github.com/libdns/infomaniak v0.2.0 // indirect
	github.com/libdns/inwx v0.3.1 // indirect
	github.com/libdns/ionos v1.2.0 // indirect
	github.com/libdns/libdns v1.1.1 // indirect
	github.com/libdns/linode v0.5.0 // indirect
	github.com/libdns/namecheap v1.0.0 // indirect
	github.com/libdns/netcup v1.0.0 // indirect
	github.com/libdns/njalla v1.0.0 // indirect
	github.com/libdns/ovh v1.1.0 // indirect
	github.com/libdns/porkbun v1.0.1 // indirect
	github.com/libdns/rfc2136 v1.0.0 // indirect
	github.com/libdns/route53 v1.6.2 // indirect
	github.com/libdns/spaceship v1.0.0 // indirect
	github.com/libdns/vultr/v2 v2.0.4 // indirect
	github.com/linode/linodego v1.56.0 // indirect
	github.com/lufia/plan9stats v0.0.0-20260330125221-c963978e514e // indirect
	github.com/magefile/mage v1.17.2 // indirect
	github.com/manifoldco/promptui v0.9.0 // indirect
	github.com/mattn/go-colorable v0.1.15 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/maypok86/otter v1.2.4 // indirect
	github.com/mdlayher/netlink v1.7.3-0.20250113171957-fbb4dce95f42 // indirect
	github.com/mdlayher/socket v0.5.1 // indirect
	github.com/mgutz/ansi v0.0.0-20200706080929-d51e80ef957d // indirect
	github.com/mholt/acmez/v3 v3.1.7 // indirect
	github.com/miekg/dns v1.1.73 // indirect
	github.com/mitchellh/copystructure v1.2.0 // indirect
	github.com/mitchellh/go-ps v1.0.0 // indirect
	github.com/mitchellh/reflectwalk v1.0.2 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/nlnwa/whatwg-url v0.6.2 // indirect
	github.com/oklog/ulid/v2 v2.1.1 // indirect
	github.com/oschwald/geoip2-golang v1.13.0 // indirect
	github.com/oschwald/maxminddb-golang v1.13.1 // indirect
	github.com/ovh/go-ovh v1.7.0 // indirect
	github.com/pbnjay/memory v0.0.0-20210728143218-7b4eea64cf58 // indirect
	github.com/petar-dambovaliev/aho-corasick v0.0.0-20250424160509-463d218d4745 // indirect
	github.com/pierrec/lz4/v4 v4.1.29 // indirect
	github.com/pires/go-proxyproto v0.15.0 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/power-devops/perfstat v0.0.0-20240221224432-82ca36839d55 // indirect
	github.com/pquerna/cachecontrol v0.2.0 // indirect
	github.com/pquerna/otp v1.5.0 // indirect
	github.com/prometheus/client_golang v1.24.1 // indirect
	github.com/prometheus/client_model v0.6.3 // indirect
	github.com/prometheus/common v0.71.0 // indirect
	github.com/prometheus/otlptranslator v1.0.0 // indirect
	github.com/prometheus/procfs v0.22.0 // indirect
	github.com/quic-go/qpack v0.6.0 // indirect
	github.com/quic-go/quic-go v0.63.0 // indirect
	github.com/redis/rueidis v1.0.54 // indirect
	github.com/rs/xid v1.6.0 // indirect
	github.com/russross/blackfriday/v2 v2.1.0 // indirect
	github.com/safchain/ethtool v0.3.0 // indirect
	github.com/shirou/gopsutil/v4 v4.26.4 // indirect
	github.com/shopspring/decimal v1.4.0 // indirect
	github.com/shurcooL/sanitized_anchor_name v1.0.0 // indirect
	github.com/sirupsen/logrus v1.10.2 // indirect
	github.com/slackhq/nebula v1.11.2 // indirect
	github.com/smallstep/certificates v0.30.2 // indirect
	github.com/smallstep/cli-utils v0.12.2 // indirect
	github.com/smallstep/linkedca v0.26.0 // indirect
	github.com/smallstep/nosql v0.8.0 // indirect
	github.com/smallstep/pkcs7 v0.2.3 // indirect
	github.com/smallstep/scep v0.0.0-20260331191114-261f960a40d1 // indirect
	github.com/smallstep/truststore v0.13.0 // indirect
	github.com/spf13/cast v1.10.0 // indirect
	github.com/spf13/cobra v1.10.2 // indirect
	github.com/spf13/pflag v1.0.10 // indirect
	github.com/tailscale/certstore v0.1.1-0.20260409135935-3638fb84b77d // indirect
	github.com/tailscale/go-winio v0.0.0-20231025203758-c4f33415bf55 // indirect
	github.com/tailscale/hujson v0.0.0-20260727124030-b80ff77dac4f // indirect
	github.com/tailscale/peercred v0.0.0-20250107143737-35a0c7bd7edc // indirect
	github.com/tailscale/tscert v0.0.0-20251216020129-aea342f6d747 // indirect
	github.com/tailscale/web-client-prebuilt v0.0.0-20260917222731-e0ed2d0d0fea // indirect
	github.com/tailscale/wireguard-go v0.0.0-20260715223240-2e01ba5b00f0 // indirect
	github.com/things-go/go-socks5 v0.1.3 // indirect
	github.com/tidwall/gjson v1.18.0 // indirect
	github.com/tidwall/match v1.2.0 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tklauser/go-sysconf v0.3.16 // indirect
	github.com/tklauser/numcpus v0.11.0 // indirect
	github.com/urfave/cli v1.22.17 // indirect
	github.com/valllabh/ocsf-schema-golang v1.0.3 // indirect
	github.com/vultr/govultr/v3 v3.21.1 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
	github.com/zeebo/blake3 v0.2.4 // indirect
	go.etcd.io/bbolt v1.5.0 // indirect
	go.etcd.io/etcd/api/v3 v3.5.18 // indirect
	go.etcd.io/etcd/client/pkg/v3 v3.5.18 // indirect
	go.etcd.io/etcd/client/v3 v3.5.18 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/contrib/bridges/prometheus v0.71.0 // indirect
	go.opentelemetry.io/contrib/exporters/autoexport v0.71.0 // indirect
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.71.0 // indirect
	go.opentelemetry.io/otel v1.46.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc v0.22.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp v0.22.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc v1.46.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp v1.46.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.46.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.46.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.46.0 // indirect
	go.opentelemetry.io/otel/exporters/prometheus v0.68.0 // indirect
	go.opentelemetry.io/otel/exporters/stdout/stdoutlog v0.22.0 // indirect
	go.opentelemetry.io/otel/exporters/stdout/stdoutmetric v1.46.0 // indirect
	go.opentelemetry.io/otel/exporters/stdout/stdouttrace v1.46.0 // indirect
	go.opentelemetry.io/otel/log v0.22.0 // indirect
	go.opentelemetry.io/otel/metric v1.46.0 // indirect
	go.opentelemetry.io/otel/sdk v1.46.0 // indirect
	go.opentelemetry.io/otel/sdk/log v0.22.0 // indirect
	go.opentelemetry.io/otel/sdk/metric v1.46.0 // indirect
	go.opentelemetry.io/otel/trace v1.46.0 // indirect
	go.opentelemetry.io/proto/otlp v1.11.0 // indirect
	go.step.sm/crypto v0.91.0 // indirect
	go.uber.org/automaxprocs v1.6.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.uber.org/zap v1.28.0 // indirect
	go.uber.org/zap/exp v0.3.0 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	go4.org/mem v0.0.0-20240501181205-ae6ca9944745 // indirect
	go4.org/netipx v0.0.0-20260823151212-3075585bcbeb // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/crypto/x509roots/fallback v0.0.0-20260929172509-b39ff6d641ec // indirect
	golang.org/x/exp v0.0.0-20260908205506-85c1c2202aba // indirect
	golang.org/x/net v0.59.0 // indirect
	golang.org/x/oauth2 v0.37.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/term v0.46.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	golang.org/x/time v0.16.0 // indirect
	golang.zx2c4.com/wintun v0.0.0-20230126152724-0fa3db229ce2 // indirect
	golang.zx2c4.com/wireguard/windows v1.0.1 // indirect
	google.golang.org/api v0.298.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260921155816-b14227669459 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260921155816-b14227669459 // indirect
	google.golang.org/grpc v1.83.2 // indirect
	google.golang.org/grpc/cmd/protoc-gen-go-grpc v1.6.2 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
	gopkg.in/ini.v1 v1.67.3 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	gvisor.dev/gvisor v0.0.0-20260224225140-573d5e7127a8 // indirect
	howett.net/plist v1.0.1 // indirect
	rsc.io/binaryregexp v0.2.0 // indirect
	tailscale.com v1.102.4 // indirect
)

// Caddy's own cel-go, held there in case a plugin's requirement would lift it: caddy-blocker-plugin
// tracks Caddy master, and a newer cel-go once broke the build (InterpretableV2). Derived from the
// pinned Caddy by update-compatibility-pins.sh, which Dependabot cannot run. Caddy moved to the
// cel.dev/cel-go path in v2.11.6; plugins still requiring github.com/google/cel-go import none of it.
replace cel.dev/cel-go => cel.dev/cel-go v0.32.0

// A security floor for the WAF engine, which coraza-caddy v2.6.1 still pins at v3.7.0 (rule
// bypass by argument flooding, multipart and audit-log fixes). Only a replace reaches the build:
// build.sh passes xcaddy the plugins and these lines, never an indirect requirement. Drop it once
// coraza-caddy requires v3.8.1 or later.
replace github.com/corazawaf/coraza/v3 => github.com/corazawaf/coraza/v3 v3.8.1

// Temporarily a fork, for a crash upstream has not merged. caddy-tailscale releases a tsnet node
// without checking whether it was ever started, and tsnet.Server.Close panics there - so a host
// that dials over the tailnet took down the admin API on the apply that stopped using it, and
// turned every container stop into a crash (exit 2, not 0).
//
// The fork is upstream's own main plus the one commit that PR proposes; nothing else diverges, so
// it is a normal `git pull upstream main` away from being current. When the PR merges, drop this
// line and move the pin in the require block forward to a commit that contains it.
//
// Nothing else guards against the crash any more, so do not drop it before then: a proxy host that
// dials over the tailnet will take the admin API down on the apply that stops using it, and turn
// every container stop into a non-zero exit.
//
//	https://github.com/tailscale/caddy-tailscale/pull/142
replace github.com/tailscale/caddy-tailscale => github.com/CaddyProxyManager/caddy-tailscale v0.0.0-20260906124601-619eb744217e
