/**
 * Links inside a demo, rendered without a destination on the server and in the browser alike.
 *
 * The components are the product's, so they link to the dashboard's routes, which do not exist
 * here. Dropping `href` in React rather than in the DOM afterwards keeps the server's markup and
 * the hydrating client's identical: Demo.astro used to strip it from the server HTML before React
 * hydrated, and every delinked anchor was a hydration mismatch. Links with a scheme go somewhere
 * real and keep theirs; so do links inside `DemoRoutes`, whose demo serves those paths itself.
 */
import { type AnchorHTMLAttributes, createContext, type ReactNode, type Ref, use } from "react";

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
  // -1 rather than none: Astryx's ClickableCard sets 0, which would keep a dead card in tab order.
  return <a {...rest} tabIndex={-1} data-cpm-demo-delinked="" />;
}

export default DemoLink;
