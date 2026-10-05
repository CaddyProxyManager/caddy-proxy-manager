# AGENTS.md

Project-specific guidance for AI coding agents.

## Repository layout

A Bun workspace. Nothing but config, docs and the Compose stack lives at the root.

| Path | What it is |
| --- | --- |
| `apps/controller` | `@cpm/controller` - the web UI, REST API, schema, migrations and the whole test suite |
| `apps/agent` | `@cpm/agent` - manages the Caddy container on its host. Was `docker/sidecar` |
| `apps/site` | `@cpm/site` - the project website and docs. Astro Starlight, built to static files |
| `packages/shared` | `@cpm/shared` - contracts both the controller and the agent hard-code |
| `docker/` | Dockerfiles and image config. Build contexts are the repo root |

Root `package.json` scripts delegate with `bun run --filter`, so `bun run test`, `bun run build` and
`bun run typecheck` still work from the root and CI needed no new working directories. Anything
reading a path off `process.cwd()` inside the controller now resolves against `apps/controller` -
the e2e suite is the exception and pins `COMPOSE_CWD` to the repo root, because Compose anchors
every relative path in every `-f` file to the first one's directory.

`apps/controller/src/lib` is grouped by feature (`auth/`, `caddy/`, `waf/`, `proxy-hosts/`...),
and the test suites mirror it. A new module goes in the folder it belongs to, not the root; a
module named after its folder is that folder's `index.ts`, so `@/src/lib/caddy` still reads short.

`bunfig.toml` pins the **isolated** installer, Bun 1.4's workspace default: a package sees only what
its own `package.json` declares. Import something a package depends on transitively and it fails at
typecheck rather than at runtime on a machine that hoisted differently - so an import that stops
resolving means adding the dependency, never loosening the linker. Note the layout this produces:
the root `node_modules` holds the store (`.bun/`) plus the root's own devDependencies, and each
workspace member gets a `node_modules` of relative symlinks into it. `docker/web/Dockerfile` copies
both trees for that reason.

## The site runs the controller's components

`apps/site` depends on `@cpm/controller` and its docs embed the real dashboard components as React
islands - the WAF card, the geo-block editor, the proxy host table - rather than screenshots of
them. Three things make that work, and all three live in `apps/site/astro.config.mjs` and
`apps/site/src/demos/`:

- **The controller's tsconfig paths are repeated as Vite aliases**, so its `@/lib/...` imports
  resolve from the site. `apps/site/tsconfig.json` mirrors them again for tsc.
- **`next-intl` and `next/navigation` resolve to shims.** Only the client hooks are used from the
  first (`useTranslations`, `useLocale`, `useFormatter`), which `use-intl` provides
  framework-agnostically; the second is reached by `DataTable`
  alone, and the shim makes the query string reactive so a demo can sort and page for real. The
  controller's `src/lib/auth/client` is shimmed too, so the sign-in demo never posts to
  `/api/auth/*` on the docs site; every attempt fails the way a wrong password does.
- **Astryx's global reset is not loaded.** It would strip Starlight's prose, so `src/demos/demo.css`
  carries the rules its components need, scoped to `.cpm-demo`. For the same reason `DemoSurface`
  renders Astryx's theme wrapper itself instead of using `<Theme>`, which would write its
  attributes onto `<html>` and restyle the whole documentation site. The controller's
  `astryx-variants.css` is imported whole; its `mobile.css` is not, because half of it pins chrome
  to the viewport - `demo.css` repeats only the `cpm-desktop-only`/`cpm-mobile-only` rules.

A component that imports a server action or the database cannot be demoed - the import would pull
the db into the browser bundle, unless `astro.config.mjs` points that action module at a shim, as it
does for the setup screens, the host editors and the access lists' Network tab. That rules out the
page clients under `(dashboard)` that import `./actions`; `AuditLogClient` is demoed because it
does not.

The site has two test suites, both run by `site.yml`. `bun run --filter @cpm/site test` holds the
data a demo copies from the controller to the original; `test:e2e` (from `apps/site`, after a
build) opens every page and fails if a demo does not hydrate or throws while it does.

## The agent connects inwards

The agent dials the controller and holds one GraphQL subscription open at `/api/graphql`,
delivered as SSE; the controller never dials the agent. Status, command results and analytics go
back as mutations to the same endpoint, and pairing is the one plain REST route
(`/api/agent/v1/pair`), because it runs before the secret every signed call needs exists. Three
consequences worth knowing before touching either side:

- **`lib/agent/registry.ts` is the only way to reach an agent.** It is in-memory, because a
  connection is a property of *this* process. "Configured" and "reachable" are therefore the same
  question, and a second controller replica would each hold half the fleet - that file is where a
  broker would go, not the callers.
- **Everything is desired state except Caddy admin.** The controller pushes the full desired state
  and the agent diffs it against what it has applied, so a dropped stream costs only a reconnect.
  The one exception is a Caddy admin call, which the controller blocks on: it goes down the stream
  with a correlation id and comes back through the `agentCommandResults` mutation.
- **The bundled agent pairs itself.** While no bundled agent is paired, the controller writes a
  single-use token to its data volume at startup (`lib/agent/bootstrap.ts`), mode 0640, which
  expires in 30 minutes and is deleted on redemption; the agent mounts that volume read-only at
  `CONTROLLER_DATA_DIR` and reads the token through the controller's group. An idle agent that
  finds one pairs with it, so the default stack needs no code typed anywhere. Unpairing the bundled
  agent turns this off until an operator turns it back on. A remote agent has no such file and uses
  a six-letter code. Both land in the same route and the same registry - only where the credential
  came from differs. An agentId that is already paired is re-paired only with a credential minted
  for that agent (the Re-pair action), never the shared code.
- **A command kind an agent has not listed in `AgentStatus.capabilities` must not be sent.** An
  older agent answers an unknown kind with silence, and the caller waits out the command timeout.
  Six are listed today. `caddy-validate`: the agent runs `caddy validate` in a throwaway,
  network-less container from Caddy's image, which is how a WAF save is checked against the real
  Coraza (`lib/waf/dry-run.ts`) without loading anything. `log-read`: a page of the access, WAF or
  Caddy log for the log viewer, with a cursor the agent alone interprets (`apps/agent/src/logs.ts`).
  `certificates`: `certificate-list` and `certificate-read` look into Caddy's storage from a
  throwaway container mounting its volumes read-only (`apps/agent/src/certificates.ts`).
  `caddy-image`: `caddy-image-load` starts loading an operator-built image and answers at once,
  since a recreate outlasts the timeout; only an agent reporting `caddyBuild.external` gets it.
  `certificate-files`: `certificate-files-list` and `certificate-files-read` browse and read PEM
  files under `CERT_FILES_HOST_DIR`, and only an agent with it set lists the capability
  (`apps/agent/src/certificate-files.ts`). `l4-port-ranges` is no command: it says `l4Ports` may
  hold ranges, which an older agent's pattern refuses, so `desired-state.ts` expands them for it.
- **With `CADDY_BUILD_MODE=external` the agent never builds Caddy's image.** A module diff is
  not acted on; the applied set is read from `/etc/caddy/caddy-modules.txt` in the image Caddy
  runs, on every start and on each load. An image without that file counts as no plugins. A load
  that drops modules narrows the applied set and waits for the controller's next config before
  recreating: `caddy run --resume` exits on an autosave naming a module the binary lacks.
- **A changed applied set is re-applied at once** (`lib/agent/module-change.ts`, from the status
  mutation), since what config may emit follows it. The narrowing above depends on this.
- **An agent is less trusted than the controller.** Whatever one agent answers may only shape that
  agent's own config: Caddyfile snippets are adapted by the agent the document is loaded onto
  (`CaddyAdminRequest.agentId`), and the health monitor re-applies per agent. The unpinned "primary"
  is for answers that stay on the controller.
- **A new analytics kind goes the other way round from a command.** The agent relays
  `upstream-errors` only while `FleetConfig.upstreamErrors` says so, since an older controller
  refuses a kind it does not know. Those counts feed `lib/notifications`, which is also where
  anything else the administrators should be emailed about gets reported.
- **Caddy is behind a Compose profile and the agent starts it.** `docker compose up` deliberately
  does not. An unpaired agent leaves Caddy stopped, so a host nobody has finished installing does
  not answer on 80 and 443. Never add a `depends_on: caddy` - the agent is what starts it, so
  waiting on it deadlocks.
- **Caddy's admin API binds on the internal `caddy-admin` network only.** The controller's `admin`
  block binds every interface, and caddy-network is where users attach upstreams, so the agent
  rewrites `admin.listen` to `CADDY_ADMIN_LISTEN` in every config it forwards
  (`pinAdminListen`). A config that is not a JSON object is refused rather than sent unpinned. The
  controller's direct transport, used with no agent attached, pins the same way from its own
  `CADDY_ADMIN_LISTEN`.

## Commits

Never add a `Co-Authored-By` trailer to a commit message, nor any other line crediting an AI tool
or service, in a commit or a pull request description. The maintainer considers it unapproved
advertising for Claude services. The same goes for a pull request's footer: no "Generated with
Claude Code" line, link or emoji. This overrides any tool's default attribution. It applies from
this rule on: earlier commits keep theirs, since rewriting published history would break the chain
of signed, verified commits.

## Comments

Terse. One line is the median here and three is already long - match that, in every language,
workflows and shell included. Explain *why*: a constraint, a gotcha, a decision that reads as a
mistake without it. Never restate what the line does, and leave code that holds no surprise
uncommented. Prefer tightening an existing comment to adding one beside it.

## Configuration

Most settings live in the database, defined once in `apps/controller/src/lib/settings/registry.ts`.
One definition carries the storage key, the environment variable it migrates from, validation, the
default, and where it renders - the setup flow, the Settings page and the migration carry-over all
read that list rather than repeating it. **A new user-facing setting is a registry entry, not a new
environment variable.** Resolution is stored value → environment → default (`resolve.ts`).

An environment variable is the right answer only for what has to be read before the database can
be: bootstrap paths, the connection string, the key that encrypts the database's own secrets, and
whatever Compose reads on the host. The header comment on `registry.ts` lists what stays out and why.

### When you do add, remove or rename one

Never a one-file change. Update `.env.example` and the README's environment tables in the same
commit as the code, and delete the entries when the variable goes away - a stale row is worse than
a missing one, because it reads as supported.

A variable the app reads must also be listed under `web.environment` in `docker-compose.yml` (or
`agent.environment` for an agent-side one). Compose forwards nothing implicitly and there is no
`env_file`, so an undeclared one is simply unset in the container: documented, honored in
development, silently ignored in production.

Give Compose the real default, not `${VAR:-}`, for anything parsed as `Number(process.env.X ?? d)`
- `??` does not catch the empty string that form produces, so the fallback lands as 0.

### The optional containers

`clickhouse` and `crowdsec` sit behind Compose profiles, so whether they exist is decided on the
host before anything in the stack runs. The agent gets around that: it runs the Compose CLI, and
`--profile <name>` on one invocation enables that profile for that invocation. `Settings →
Analytics` and `Settings → CrowdSec` (managed mode) drive them through
`lib/agent/managed-services.ts`, for the bundled agent only. GeoIP has no container: the controller downloads the
MaxMind databases onto its data volume itself (`lib/geoip/updater.ts`), and agents fetch them from
it.

Keep in mind when touching it:

- **A credential a managed service needs must reach Compose through the agent's child environment**, not
  a generated env file - Compose reads the process environment at a higher precedence than any
  `--env-file`, and a value passed that way needs no quoting. `MANAGED_SERVICE_ENV_KEYS` is the
  allowlist; widening it means the controller can set that variable on a spawned `docker`.
- **Nothing in the base compose file may guard a managed service's variables with `${VAR:?}`.**
  Interpolation happens per file before Compose decides what to act on, so a `:?` fails every
  invocation naming the project - including ones for unrelated services - on a deployment that
  keeps the value in the database instead of `.env`.
- **The agent never reads `.env`.** It passes `--env-file /dev/null` and its own placeholders for the
  two `:?` variables, so a variable the `caddy` or `clickhouse` definitions
  interpolate must also be forwarded under `agent.environment`, or the agent's compose sees its
  default. `crowdsec`'s are not: the controller generates the bouncer key and sends both on every
  invocation that touches that service, so `.env` has nothing to add.

### Adding a DNS provider

Only on request - each module grows the Caddy image. It must build against libdns v1 (Caddy
2.10+), which many `caddy-dns/*` repositories still don't; check that before anything else. Then,
in one commit:

- the entry in `apps/controller/src/lib/dns/providers.ts` (`password` fields are encrypted at rest)
  and its `settings.dnsProviders.<name>` labels in `en.json`;
- the module path in `SHIPPED_CADDY_MODULES` (`packages/shared/src/caddy-modules.ts`), the
  `CADDY_MODULES` ARG in `docker/caddy/Dockerfile`, and the import in `docker/caddy/tools.go`, with
  its pin in `docker/caddy/go.mod` from `go get`;
- a test in `tests/unit/dns/dns-providers.test.ts` for the challenge JSON it emits;
- its name in the provider list, and the count, in `apps/site/src/content/docs/features/certificates.mdx`
  and `index.mdx`.

## User-facing text

Every string a person reads comes from `apps/controller/messages/en.json` through next-intl. English
is the source catalog; adding a language is one more file there plus an entry in `LOCALES`
(`src/lib/locale/index.ts`), and nothing else.

- Client components: `const t = useTranslations("<namespace>")`. Server components and route
  handlers: `const t = await getTranslations("<namespace>")` - the hook throws outside a component.
- Namespaces mirror the route or component folder (`waf`, `proxyHosts`, `settings`), with `common`,
  `nav`, `ui` and `passwordPolicy` shared across screens.
- `src/types/next-intl.d.ts` types the keys off `en.json`, so a typo is a build error rather than a
  key rendered to a user. That only works for literal keys - where a key is composed at runtime
  (a setting name, a validation code) a test asserts the catalog covers it instead. See
  `tests/unit/settings/settings-messages.test.ts`.
- **Never build a sentence by concatenation.** `` `${label} must be a number` `` cannot be
  translated, because not every language puts the subject first. Return a code and let the catalog
  hold the whole sentence - `auth/password/policy.ts`, the settings registry and
  `errors/domain-error.ts` all do this, and their headers explain the shape.
- Models raise `domainError("code")` rather than `new Error("sentence")`. They run for a server
  action, for `/api/v1/*` and for the agent's sync, and only the first has a reader with a language:
  the code is rendered by `actionError`, and the English `message` the error still carries is what
  the REST layer keeps returning.

The locale is a cookie (`cpm-locale`), not a URL segment: `src/proxy.ts` authorizes on path
prefixes, forward auth serves the portal on someone else's domain, and the REST API is versioned by
path. With no cookie the locale is negotiated from `Accept-Language`, then refined on the client
from `navigator.languages` - Chrome trims the header to one language, so the client sees choices the
server cannot.

Timestamps render in the reader's time zone, which the browser writes to a cookie (`cpm-tz`,
`src/lib/locale/time-zone.ts`) and `src/i18n/request.ts` hands to next-intl, so the server render
and the browser's agree. Show one with `components/ui/Timestamp.tsx`: local text, and the UTC
instant in a tooltip for searching logs. Never `toLocaleString()` - it formats in whatever zone and
locale the runtime has, which differs between the container and the browser.

Two things that are not obvious and will cost an afternoon:

- **`createNextIntlPlugin` must not be used.** It reads `next/package.json` and throws under Vite.
  vinext finds `src/i18n/request.ts` by path and registers the alias itself, so moving or renaming
  that file disables next-intl silently.
- **`<NextIntlClientProvider>` is given `locale` and `messages` explicitly.** next-intl documents
  them as optional in the App Router, but vinext runs RSC and SSR as separate Vite environments and
  the request config does not cross that boundary. Left to infer, the SSR pass throws and the page
  500s with the RSC payload already correct - which makes it look like anything but the provider.

What stays in English: messages thrown before a request exists (`config.ts` validating
`ADMIN_PASSWORD` at startup goes to the container log), and `/api/v1/*` responses, which are a
machine contract rather than UI copy.

## Two database backends

PostgreSQL by default, SQLite when `DATABASE_URL` names a file (`src/lib/db/dialect.ts`). Both run
the same app code:

- **`schema.pg.ts` is the source of truth.** `schema.sqlite.ts` is generated from it
  (`scripts/generate-sqlite-schema.ts`) and each dialect has its own migrations folder. After a
  schema change, run the generator and `db:generate` once per dialect; the parity test catches a
  skipped step.
- **`db` is typed as PostgreSQL either way**, so a SQLite-only call fails typecheck. The reverse
  is on you: raw `sql` must be portable (no `::int`, `setval`, `ILIKE`), and a dialect-specific
  step branches on `schemaDialect` from `src/lib/db/schema`, never on the connection module, which
  opens the database on import.
- **Transactions go through `runInTransaction`.** bun:sqlite commits when its synchronous callback
  returns, so an async `db.transaction` body would commit before its first `await`.

## Tests

`bun run test` from the root runs everything. It starts a throwaway PostgreSQL container, gives
each test its own schema, and removes it afterwards; `TEST_POSTGRES_URL` points at a server of your
own instead. `bun run test:sqlite` runs the same suite on an in-memory SQLite database per test.
Three constraints are not obvious from reading the suites:

- **`mock.module` is global and leaks across files sharing a process.** The agent's tests run with
  `--parallel` for that reason - a `node:fs` mock in one file was reaching every file that ran
  after it. A test that passes alone and fails in the suite is this, not flake.
- **Mock `src/lib/db` with `dbModuleMock` (`tests/helpers/db-module.ts`), never inline.** The
  preload has already loaded the real module, so Bun patches its exports in place and a name a
  factory leaves out stays real - a `runInTransaction` left out wrote to the app's own connection.
  That connection is never migrated under test, so such a miss fails loudly instead of sharing data.
- **A PR labelled `e2e` runs only the specs its files map to**
  (`apps/controller/scripts/select-e2e.ts`); `e2e-full` runs them all, as a dispatch does. Nothing runs on merge. An
  unmapped path runs everything, so a new source folder needs a rule to stay cheap, and a new spec
  must be named by one - `tests/unit/ci/select-e2e.test.ts` fails if not.
- **Playwright specs run under Node, not Bun.** `bun:sqlite`, `Bun.password` and the rest are
  unavailable in `tests/e2e/**`. Anything needing them belongs in a script the spec spawns with
  `bun` - see `tests/helpers/build-legacy-db.ts`.

<!-- ASTRYX:START -->
Astryx v0.4.5 · 90+ components
CLI: run every command as `bunx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) - without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW - discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` - START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` - scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` - props + examples for every component you use.

RULES:
- No <div> - components do all layout/spacing, page frame included.
- Frame first: read `astryx docs layout` before writing any page or screen - page frame, region widths, breakpoint behavior.
- Dense data = rows (Table, List/Item), never Card-wrapped list items; Card is for standalone widgets. Status = StatusDot/Token; Badge = counts only.
- Custom styling: component props first; else Tailwind utilities backed by tokens (bg-surface, text-primary, rounded-lg) via tailwind-theme.css. No raw hex/px.
- Tokens for every value (`astryx docs tokens`). Brand/accent belongs in the theme (`astryx theme list` / `theme add <slug>`, or `astryx theme template` for a custom one) - never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any style={{…}}, raw <div>/<span> layout, imported .css/@apply, or hardcoded/arbitrary value (e.g. bg-[#fff], p-[13px]) with the component or a token-backed utility. If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   90+ components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes - APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` - verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
