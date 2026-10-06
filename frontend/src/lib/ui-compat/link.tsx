/*
 * React Router compatibility surface for forward-ported presentation: links.
 *
 * Historical xCloud components used the Next.js `Link` with an `href` prop. Two
 * things differ in React Router: `Link` is a NAMED export, and the destination
 * prop is `to`. Porting therefore needs both a named export and a tolerant prop
 * name, or every ported call site becomes a manual edit with a silent failure
 * mode (a broken default import builds nothing, but a stale `href` renders an
 * anchor that navigates by full page load).
 *
 * `AppLink` accepts either prop, and keeps genuinely external destinations as
 * plain anchors so the SPA router is never asked to handle them.
 */
import { forwardRef } from 'react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { isLocalDestination } from './router';

/** Re-exported so ported modules can import the router link from one place. */
export { RouterLink as Link };
export type { LinkProps } from 'react-router-dom';

export type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  /** Canonical destination. */
  to?: string;
  /** Historical prop name. Prefer `to`; accepted so ported markup keeps working. */
  href?: string;
  /** Accepted for call-site compatibility with the historical link component. */
  prefetch?: boolean;
  /** Accepted for call-site compatibility; the SPA performs a client-side replace. */
  replace?: boolean;
  /** Accepted for call-site compatibility; the SPA restores scroll itself. */
  scroll?: boolean;
  children?: ReactNode;
};

export const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(function AppLink(
  { to, href, prefetch, replace, scroll, children, ...rest },
  ref,
) {
  const destination = to ?? href ?? '';
  void prefetch;
  void scroll;

  if (!isLocalDestination(destination)) {
    /* External, protocol-relative or empty destination: keep it a plain anchor. */
    return <a ref={ref} href={destination} {...rest}>{children}</a>;
  }

  return (
    <RouterLink ref={ref} to={destination} replace={replace} {...rest}>
      {children}
    </RouterLink>
  );
});
