# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < 3.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by:

1. **DO NOT** open a public issue
2. Email the maintainers or use GitHub's private vulnerability reporting
3. Include detailed information about the vulnerability:
   - Type of vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and provide regular updates on the fix progress.

## Security Measures

### Build Pipeline Security

Our CI/CD pipeline implements multiple security layers:

1. **Nothing published from a pull request**: images are built and pushed by one workflow
   (`docker-build-trusted.yml`). A pull request - from a fork or otherwise - runs the test and
   end-to-end suites and never touches the registry, so there is no build-and-push path for
   untrusted code to reach.
2. **Only a release tag on `main` publishes**: `release.yml` tags a release when `package.json`'s
   version changes on `main`, then dispatches the image build at that tag and the docs site build on `main`. The build's first job
   refuses any ref that is not a `vX.Y.Z` tag whose commit is reachable from `main`, so a manual
   dispatch on a branch publishes nothing. Anyone who can push tags can still start a build, but
   only of a commit that already landed on `main`.
3. **`latest` follows prereleases, for now**: `docker-compose.yml` runs `:latest`, and 3.0.0 has
   only release candidates, so the newest prerelease moves `latest`. Once a stable `v3` tag exists,
   only stable releases move it. Re-dispatching an older tag republishes its own version tags but
   never moves `latest`, `3` or `3.0` back. To avoid tracking `latest` at all, deploy from the
   release archive, which pins the three images to that release.
4. **Pinned inputs**: every GitHub Action is pinned to a full commit SHA, every base and third-party
   image to a tag and digest, and CI's Bun to the version the images build with. The agent image
   pins `docker-ce-cli` and `docker-compose-plugin` to a major version only, because Docker's apt
   repository drops old builds.
5. **Automated pull requests**: Dependabot proposes the bumps above. `caddy-compatibility-pins.yml`
   opens its pull request with `GITHUB_TOKEN`, which starts no workflow, so the test and end-to-end
   checks do not run on it until a maintainer closes and reopens it or pushes to its branch.
6. **SBOM Generation**: Software Bill of Materials is generated for all builds
7. **Provenance Attestation**: Build provenance is recorded for supply chain security
8. **Limited Permissions**: Workflows use minimal required permissions. The test workflow declares
   `permissions: {}`, so its `GITHUB_TOKEN` carries no scopes, and it references no repository secrets

### Container Security

- Multi-architecture builds (linux/amd64 and linux/arm64)
- Base images pinned by digest, with weekly Dependabot updates for all three Dockerfiles and the
  images `docker-compose.yml` runs
- Web, Caddy and the agent run as their own non-root users
- **Networks follow who needs whom.** `caddy-network` holds Caddy, web, the agent (for egress) and
  the upstreams you attach. Caddy's admin API, PostgreSQL and ClickHouse each sit on an internal
  network (`caddy-admin`, `database`, `analytics`) shared only with the containers that use them,
  so a container attached to be proxied reaches none of them. Web downloads the GeoLite2 databases
  from MaxMind over its `caddy-network` egress.
- `/acme-ca`, which decides the CA Caddy trusts for ACME, is owned by web's user with mode `0755`,
  and Caddy mounts it read-only. A volume created by an earlier release keeps its old `0777` mode
  until tightened by hand; the README's upgrade notes show how.

### The Agent Is Root on Its Host

The agent recreates Caddy and starts ClickHouse through the Docker API, which it
reaches only through `docker-socket-proxy`, a
[wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy). That proxy allows, per
method, the container, image, volume and network endpoints the agent's Compose and `docker` calls
use, plus BuildKit's `/grpc` and `/session`, and denies exec, attach, the legacy `/build`, swarm,
secrets, auth, events and everything else.

**Treat the proxy as narrowing the API, not as a boundary.** It matches the method and path of a
request and never sees its body, so the same `POST /containers/create` that recreates Caddy could
ask for a privileged container, the host's PID namespace or `/` bind-mounted, and `PUT
/containers/{id}/archive` could write files into any container. The two BuildKit endpoints are
looser still: once allowed, the connection upgrades to h2c and is piped to the socket unfiltered
from then on. Whatever controls the agent, or can reach the proxy, is root on that host. The
proxy's `-allowbindmountfrom` can refuse bind mounts from outside listed directories; the stack
does not set it, since what Caddy mounts from differs per host, but an override can.

The controls that matter are therefore:

- **The agent validates what it is told.** Desired state from the controller is checked on the
  agent before it reaches Docker: published ports, Caddy module paths, the environment variables a
  managed service may receive, and GeoIP edition names. Caddy admin calls pass a path allowlist.
  A WAF dry run creates a container from the Caddy image itself, with no network, no mounts and
  no capability but the one Caddy's binary needs, and copies the config in. Reading certificates
  runs the same kind of throwaway, network-less container with Caddy's volumes read-only, for
  names that must look like a storage path component. A log cursor must look like one before it
  becomes a `docker compose logs` argument.
- **The agent stays minimal.** Its image holds the compiled agent, the Docker CLI and the Compose
  plugin, and it is the only container on the proxy's internal network.
- **The agent does not read `.env`.** It mounts the compose directory read-only to run Compose, but
  passes `--env-file /dev/null` and placeholders for `SESSION_SECRET` and `POSTGRES_PASSWORD`, and
  gets the variables its services need from its own environment. Keep `.env` at mode `0600`.
  Anything else in that directory that other users can read - an override file, `.git` - the agent
  can read.

### Caddy Module Builds

**Settings → Caddy Build** lets an admin choose which plugins Caddy is compiled
with, and add their own. Two consequences are worth stating plainly:

- **Custom modules are arbitrary code in the proxy.** A module added there is
  fetched from its Go module path, compiled into the Caddy binary, and runs with
  the proxy's privileges on every request. Treat adding one exactly as you would
  treat merging code into this repository. Module paths are validated against a
  strict allowlist before they reach the build (see `validateCustomModule`), so
  a path cannot inject shell into the Dockerfile - but a *valid* path to a
  malicious repository is still malicious.

- **Rebuilding needs `SP_ALLOW_POST_BUILDKIT`** on `docker-socket-proxy`, set by
  default. Image builds add little to an API that is already root-equivalent
  (see above), but set it to `""` to opt out, with `CADDY_BUILD_MODE=external`
  on the agent: you build the image, and the agent only loads it. A custom
  module is then compiled by you, not by whoever controls the agent.

Only admins can reach either surface. Custom Caddy configuration is likewise admin-only, and so is
pointing an upstream at Caddy's admin port, a unix socket or a placeholder: an operator granted a
host can edit its upstreams, but not reach the admin API through it.

The Caddy image an agent in external build mode loads is whatever the operator built and tagged.
The agent reads the module list from that image, and an image without one is treated as having no
plugins, so config generation never names a module it may lack.

### Proxied Traffic

- **The WAF inspects WebSocket upgrades.** An upgrade used to skip it, so two added headers took
  an attack past the WAF on any host with WebSocket support on. The handshake is now inspected like
  any request; the messages after it are not. With **WebSocket Support** off a host refuses
  upgrades with 403, matched case-insensitively and including HTTP/2's extended CONNECT.
- **Access lists keep basic-auth credentials from the upstream** unless **Pass auth to host** is
  on. Lists made before that switch existed keep forwarding them, as they always did. IP rules
  match the client address Caddy resolves, so they see through trusted proxies only.
- **The Caddy cache stores nothing per-user.** It covers static asset paths only, skips any
  request carrying a cookie or an `Authorization` header, and a response that sets a cookie is
  marked `private` before any cache sees it. A stored Redis password is kept only while the servers
  stay the same, so repointing them cannot hand it to another host.
- **Redirects that keep the path cannot be turned into open redirects.** A request path that would
  make the `Location` protocol-relative (`//evil.example`, `/\evil.example`) is not redirected.

### First-run Setup

An installation with no accounts serves nothing but the setup flow, and that flow is necessarily
public - there is no account to authenticate against yet. **Whoever reaches a fresh deployment
first becomes its administrator.** Complete setup before the instance is reachable from anywhere
you do not control, or set `ADMIN_USERNAME`/`ADMIN_PASSWORD`, which seeds an admin at startup and
skips the flow entirely.

Once setup completes the flag is stored, and the setup screens redirect away for good. Two requests
racing for the account step cannot both create an administrator: the step runs under a claim row
in the database, and checks again that no account exists while it holds it.

### Sign-in and Forward Auth

- **Guessing is limited by address and by account.** Dashboard and forward-auth sign-in count
  failures per client address and per username, with a backoff that doubles up to 15 minutes. The
  client address is the connection's own peer unless that peer is loopback, Caddy or a configured
  trusted proxy; `X-Real-IP` is never trusted.
- **Each derived key has one purpose.** The reachability probe on `/api/health` and the proof Caddy
  attaches to forward-auth requests are keyed separately from `SESSION_SECRET`, so no probe answer
  can stand in for the proof.
- **Changing credentials takes a fresh sign-in.** Setting a first password on a provider-only
  account needs a session under ten minutes old, unlinking a provider needs the password, and a
  password change ends the user's other sessions and forward-auth sessions. Better Auth's own
  password, profile, account and token routes are switched off in favour of the app's. Downloading
  a certificate's private key and restoring a backup need the same ten-minute session, and every
  key downloaded is audited.
- **Two-factor sign-in covers the portal too.** The forward-auth portal checks passwords itself,
  so a password alone would otherwise reach every protected host. For an account with two-factor
  sign-in it answers the password with a short-lived signed challenge, bound to the user and the
  redirect, and finishes only on a TOTP or backup code, under the same per-account lockout as the
  dashboard. A backup code is spent with a compare-and-swap, so two concurrent uses cannot both
  succeed. The TOTP secret and backup codes are encrypted with a key from `SESSION_SECRET`.
- **Requiring it for administrators binds sessions, not tokens.** Until an administrator with a
  password enrols, the dashboard sends them to enrolment and their session's REST and GraphQL
  calls answer 403, but an API token they already hold keeps working. Accounts that sign in only
  through OAuth are left to the identity provider. `cpm-server --reset-2fa` is answered only on
  loopback, signed with a key derived from `SESSION_SECRET`, and audited.
- **View as only narrows.** An administrator previewing a role or group narrows their own session:
  it is read against the account's real role, so a demotion cancels it, it ends after an hour, and
  the require-2FA check reads the real role. Minting an API token and forward-auth sign-in are
  refused while it is on.
- **There is always an active administrator.** Every change that can remove one - role, status,
  delete, and OIDC role sync - runs under one cross-process lock and refuses to remove the last.

### Backups

**A backup file holds every secret the database encrypts.** DNS credentials, certificate and CA
private keys, agent secrets, OAuth client secrets, two-factor secrets and the rest are decrypted
into it, beside password and API token hashes, so that it restores under a different
`SESSION_SECRET`. The passphrase is then the only thing protecting it: the payload is sealed with
AES-256-GCM under a key from scrypt, the passphrase must be at least 12 characters, and the
readable header (version, date, row counts) is authenticated as additional data, so editing it
breaks decryption. Live sessions and sign-in state are never included.

- **Any admin can take one**, from Settings or with an admin API token through
  `POST /api/v1/backup`. An admin token can therefore export every secret, under a passphrase of
  its own choosing. Each download is audited.
- **Restoring needs a sign-in from the last ten minutes**, since it replaces every account. It
  signs everyone out, refuses a backup from a newer release (checked again once the header is
  authenticated), and closes the stream of any connected agent the restored agents table no longer
  vouches for before the restored config is pushed.
- **A restore leaves a copy of what it replaced** in `backups/` on the controller's data volume,
  mode `0600`, sealed with the passphrase of the backup being restored. The agent mounts that
  volume read-only but reads it through the controller's group, which that mode excludes. Delete
  the copies once you no longer need them.

### Controller and Agent

The agent dials the controller; the controller never dials the agent. Pairing, the event stream
(a GraphQL subscription at `/api/graphql`, delivered as SSE, one per agent), status reports, command
results and relayed analytics events (mutations on the same endpoint) and the GeoLite2 download are
all agent-to-controller requests. Configuration goes down the stream as desired state. A Caddy admin
call is the one command the controller waits on: it goes down the stream with a correlation id, and
the agent posts the answer back.

Those requests are signed rather than bearer-authenticated. Each carries an HMAC-SHA256, keyed by
the pairing secret, over the method, path, timestamp, a nonce and a hash of the body:

- **The secret never travels with a request**, so it cannot be lifted from a proxy log or a
  `curl -v` pasted into an issue.
- **The path is bound into the signature**, so a captured read cannot be replayed as a write.
- **The body is bound too**, so a valid request cannot be edited in flight.
- A ±60 second window bounds replay, and a nonce seen inside that window is refused.

**Pairing.** The agent in the controller's own stack pairs with a single-use bootstrap token the
controller leaves on its data volume. The token is written only while that agent is unpaired,
expires after 30 minutes, and is not written again after an admin unpairs the agent until
auto-pairing is switched back on. An agent on another host pairs with a six-letter code valid for
five minutes and burned on first use. Wrong guesses are limited per client address, and each code
is discarded after 200 of them. The two sides exchange a secret, which is encrypted with
`encryptSecret` before it reaches a row and is never returned to the browser, logged, or included
in any view type.

- **A pairing never replaces an existing one.** An agent id the controller already knows can only
  be paired again with a code an admin mints from that agent's row, and a disabled agent cannot
  pair at all.
- **Remote agents default to HTTPS.** A bare host name means `https://`, except loopback and
  single-label names such as `web`. Plain `http://` to a private address is allowed with a
  warning, and to a public address it is refused unless `CONTROLLER_ALLOW_INSECURE_HTTP` is set.
- **Unpairing closes the agent's stream** and forgets the controller's side. Restart the agent as
  well if you are removing one you no longer trust.

**The agent's Caddy admin proxy is an allowlist**, not a sanitiser: `/load`, `/config/`, `/adapt`
and `/reverse_proxy/upstreams` are the four paths the controller needs. Caddy's admin API can stop
the server outright, so a request for anything else is treated as not having come from this
application, whatever signed it.

**An agent answers only for its own Caddy.** Each agent adapts Caddyfile snippets for the config
it is sent, and the health monitor re-applies config only to the agent that reported a problem. A
compromised agent can misconfigure its own Caddy, but never another agent's. A snippet is checked
against every connected agent that serves the host before it is saved.

**What an agent sends is decoded, never cast.** A signature proves which agent sent a value, not
its shape, so status reports, command results, certificate listings and files, and log pages are
checked and bounded field by field, with unknown fields dropped. A malformed report is refused, and
a malformed answer fails its one command at once instead of leaving the caller waiting out the
timeout. The image name and IDs an agent in external build mode reports are checked before they
appear in the `docker build` command the Caddy Build page shows, since that is pasted into a shell.

**Caddy's admin API is not on the upstream network.** The bundled compose file binds it to Caddy's
address on the internal `caddy-admin` network, which only web and the agent share. The agent pins
that address into every config it forwards, since the controller's own `admin` block binds every
interface, and the controller pins it the same way when it loads a config with no agent attached.
A deployment without that network or without `CADDY_ADMIN_LISTEN` - an older compose file - keeps
the open bind, where only leaving port 2019 unpublished bounds who can reach it.

**The GeoLite2 route hides itself.** Every refusal on it answers `404` - unsigned, unknown agent id,
stale timestamp, disabled agent, unknown database edition are all identical from outside, so
nothing can learn the route exists or which agent ids are real without already holding a secret.

**The MaxMind licence key stays on the controller.** The controller downloads the databases itself
and agents fetch them through that route, so no agent is ever sent the key. Each download's archive
is checked for a MaxMind database before it replaces the file agents are served.

**Agents hold no ClickHouse credential.** Each host parses its own Caddy logs and relays the events
to the controller as a signed request. The controller checks every field, drops a malformed row,
records the agent that sent each one (`agent_id`) and writes it itself. A compromised agent can
still report false events for any host name, but they are attributable to it, and it cannot read,
alter or drop anyone's analytics. The one exception is the agent in the controller's own stack,
which is sent the ClickHouse password because Compose needs it to start the container there.

**`SESSION_SECRET` is the root of all of it.** It derives the key that encrypts DNS provider
credentials, imported and mTLS CA private keys, agent secrets, two-factor secrets and the secret
settings, the HTTP cache's Redis password and CDN API key among them. Rotate it by setting the
new value as `SESSION_SECRET` and the old one as `SESSION_SECRET_PREVIOUS`: the next start
re-encrypts every secret under the new key, after which the previous one can go. Without the
previous value every one of them is unreadable, and only a [backup](#backups) carries them across.

### Dependency Management

- Automated dependency updates via Dependabot: Bun packages, the Go modules compiled into Caddy,
  GitHub Actions, the three Dockerfiles and `docker-compose.yml`
- Security alerts enabled
- Regular security audits

## Security Best Practices for Contributors

When contributing:

1. Never commit secrets, tokens, or credentials
2. Use environment variables for sensitive configuration
3. Keep dependencies up to date
4. Follow principle of least privilege
5. Validate and sanitize all user inputs
6. Use parameterized queries for database operations

## Automated Security Checks

Our repository includes:

- **Dependabot** for dependency updates
- **GitHub Security Advisories** monitoring

## Reviewing a fork pull request

No workflow publishes anything from a pull request, so review is about what merging would let in
rather than what the run itself can do:

1. Review the PR code thoroughly for malicious content
2. Check for suspicious file modifications - workflow files and `docker/` especially, since those
   decide what a later release builds and pushes
3. Verify no secrets or credentials are exposed

## Upgrading

Releases after 3.0.0-rc.3 move Caddy's admin API, PostgreSQL and ClickHouse onto internal networks
and stop the agent reading `.env`. An existing Caddy container has to be replaced once, and a
`CADDY_API_URL` or an override file that interpolates variables may need changing. The README's
"Upgrading to the isolated Caddy admin API" lists the steps.

WebSocket upgrades now go through the WAF, so a handshake the CRS flags is refused where it used to
pass, and a host with WebSocket support off refuses upgrades whether or not its WAF is on. The
README's "Upgrading to WAF-checked WebSockets" says what to check.

## Security Updates

Security updates are prioritized and released as soon as possible. Subscribe to repository releases to stay informed.
