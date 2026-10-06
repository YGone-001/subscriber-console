/*
 * React Router compatibility surface for forward-ported presentation.
 *
 * Historical xCloud components were written against the Next.js App Router hooks
 * (`useRouter`, `usePathname`, `useParams`, `useSearchParams`). Porting them by
 * hand means rewriting every call site and hoping nothing was missed. Porting
 * them onto this module instead keeps the call sites intact: the shape of the
 * returned values matches what the historical components already expect, while
 * the implementation is React Router.
 *
 * This module is presentation plumbing ONLY. It deliberately does not emulate
 * Server Components, server actions, route-level data loading, prefetching, or
 * caching — the current read client and mutation client own all data access.
 */
import { useMemo } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

export type AppNavigateOptions = {
  replace?: boolean;
  state?: unknown;
  /** Relative resolution mode, mirroring the historical router options. */
  relative?: 'route' | 'path';
};

export type AppRouter = {
  /** Navigate forward. External destinations leave the SPA instead. */
  push: (to: string, options?: AppNavigateOptions) => void;
  /** Navigate without adding a history entry. */
  replace: (to: string, options?: AppNavigateOptions) => void;
  /** Go back one history entry. */
  back: () => void;
  /** Go forward one history entry. */
  forward: () => void;
  /** Accepted for call-site compatibility. SPA routes need no prefetch. */
  prefetch: (to: string) => void;
  /** Accepted for call-site compatibility. Data refresh is owned by the read client. */
  refresh: () => void;
};

/**
 * A destination is local when it stays inside this SPA. Anything with a scheme
 * (`https:`, `mailto:`, `tel:`), a protocol-relative prefix (`//host`), or an
 * origin other than the current one must not be pushed into the router.
 */
export function isLocalDestination(target: string): boolean {
  const value = (target ?? '').trim();
  if (!value) return false;
  if (value.startsWith('//')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  if (!value.startsWith('/') && !value.startsWith('?') && !value.startsWith('#')) return false;
  return true;
}

/** Build a path from a template containing `:name` segments. Values are encoded once. */
export function buildLocalPath(template: string, values: Record<string, string | number>): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) return match;
    return encodeURIComponent(String(value));
  });
}

/** The subset of React Router's navigate function this module depends on. */
export type AppNavigate = (
  to: string | number,
  options?: { replace?: boolean; state?: unknown; relative?: 'route' | 'path' },
) => void | Promise<void>;

/**
 * Build the historical router surface over a navigate function.
 *
 * Kept as a pure factory so the navigation semantics (which destinations reach
 * the router, and with which options) are testable without a DOM: React Router
 * deliberately no-ops `useNavigate` outside an effect, so a server-rendered
 * probe cannot exercise it.
 */
export function createAppRouter(
  navigate: AppNavigate,
  assign: (url: string) => void = (url) => { if (typeof window !== 'undefined') window.location.assign(url); },
): AppRouter {
  const go = (to: string, options: AppNavigateOptions | undefined, defaultReplace: boolean) => {
    if (!to || !to.trim()) return; /* an empty destination is a no-op, not a navigation */
    if (!isLocalDestination(to)) {
      /* Leaving the SPA: hand the destination to the browser, never to the router. */
      assign(to);
      return;
    }
    navigate(to, { replace: options?.replace ?? defaultReplace, state: options?.state, relative: options?.relative });
  };

  return {
    push: (to, options) => go(to, options, false),
    replace: (to, options) => go(to, { ...options, replace: true }, true),
    back: () => { navigate(-1); },
    forward: () => { navigate(1); },
    prefetch: () => { /* no-op: routes are already local bundles */ },
    refresh: () => { /* no-op: the read client owns revalidation */ },
  };
}

export function useAppRouter(): AppRouter {
  const navigate = useNavigate();
  return useMemo(() => createAppRouter((to, options) => {
    /* React Router overloads numeric deltas and path descriptors separately. */
    if (typeof to === 'number') navigate(to);
    else navigate(to, options);
  }), [navigate]);
}

/** The current pathname, without search or hash. */
export function useAppPathname(): string {
  return useLocation().pathname;
}

/**
 * Raw dynamic route parameters, exactly as the router matched them.
 *
 * Values are returned as strings and are NOT decoded a second time, so a segment
 * such as `a%2520b` stays `a%20b` and an all-digit identifier such as an IMSI
 * stays a string rather than being coerced to a number.
 */
export function useAppParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  return useParams() as T;
}

/** A single raw dynamic route parameter. */
export function useAppParam(name: string): string | undefined {
  return useParams()[name];
}

/**
 * The current query string as a `URLSearchParams`-compatible object.
 *
 * The historical hook exposed `get`, `getAll`, `has`, `toString` and iteration;
 * `URLSearchParams` provides all of them, so ported call sites keep working.
 */
export function useAppSearchParams(): URLSearchParams {
  return useSearchParams()[0];
}

/** A single query parameter value. */
export function useAppSearchParam(name: string): string | null {
  return useSearchParams()[0].get(name);
}

/** The current location as a path-plus-query string, for equality checks. */
export function useAppLocationKey(): string {
  const location = useLocation();
  return `${location.pathname}${location.search}${location.hash}`;
}
