/**
 * Links inside a demo, rendered as plain spans on the server and in the browser alike.
 *
 * The components are the product's, so they link to the dashboard's routes, which do not exist
 * here. Unlinking in React rather than in the DOM afterwards keeps the server's markup and
 * the hydrating client's identical: Demo.astro used to strip it from the server HTML before React
 * hydrated, and every delinked anchor was a hydration mismatch. Links with a scheme go somewhere
 * real and keep theirs; so do links inside `DemoRoutes`, whose demo serves those paths itself.
 */
import {
  type AnchorHTMLAttributes,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  use,
} from "react";

const RoutesContext = createContext(false);

/** For a demo that answers its own links, as the setup flow does. */
export function DemoRoutes({ children }: { children: ReactNode }) {
  return <RoutesContext value>{children}</RoutesContext>;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

type DemoLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href?: string | { pathname?: string | null } | null;
  ref?: Ref<HTMLAnchorElement>;
  // next/link's and Astryx's router props, which an anchor has no use for.
  to?: unknown;
  prefetch?: unknown;
  replace?: unknown;
  scroll?: unknown;
  shallow?: unknown;
  passHref?: unknown;
  legacyBehavior?: unknown;
  locale?: unknown;
};

export function DemoLink({
  href,
  to: _to,
  prefetch: _prefetch,
  replace: _replace,
  scroll: _scroll,
  shallow: _shallow,
  passHref: _passHref,
  legacyBehavior: _legacyBehavior,
  locale: _locale,
  ...rest
}: DemoLinkProps) {
  const servesRoutes = use(RoutesContext);
  const target = typeof href === "string" ? href : (href?.pathname ?? "");
  if (servesRoutes || HAS_SCHEME.test(target)) return <a {...rest} href={target} />;
  const {
    ref,
    target: _target,
    rel: _rel,
    download: _download,
    hrefLang: _hrefLang,
    ping: _ping,
    referrerPolicy: _referrerPolicy,
    type: _type,
    media: _media,
    // A card's overlay link names the card; with no link it only repeats what the card shows,
    // and a span may not carry it.
    "aria-label": _ariaLabel,
    // Astryx's ClickableCard sets 0, which would keep a dead card in tab order.
    tabIndex: _tabIndex,
    ...attributes
  } = rest;
  // A span: an anchor with no href is no link, and audits rightly flag one.
  return (
    <span
      {...(attributes as HTMLAttributes<HTMLSpanElement>)}
      ref={ref as Ref<HTMLSpanElement> | undefined}
      data-cpm-demo-delinked=""
    />
  );
}

export default DemoLink;
