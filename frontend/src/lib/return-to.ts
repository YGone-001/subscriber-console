/*
 * List-to-detail return context.
 *
 * List state (filters, sort, page) lives in the URL. A detail page that always
 * links back to the bare list loses that context, so list links carry the
 * current list URL in `returnTo`. The value is untrusted input: only a
 * same-origin relative path under the detail page's own list is accepted.
 */

const RETURN_TO_PARAM = 'returnTo';

export function withReturnTo(path: string, listLocation: string): string {
  const [base, query = ''] = path.split('?', 2);
  const params = new URLSearchParams(query);
  params.set(RETURN_TO_PARAM, listLocation);
  return `${base}?${params.toString()}`;
}

export function resolveReturnTo(
  search: string,
  fallback: string,
  allowedListPrefixes: readonly string[],
): string {
  const value = new URLSearchParams(search).get(RETURN_TO_PARAM)?.trim() ?? '';
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;

  const path = value.split('?', 1)[0].split('#', 1)[0];
  const allowed = allowedListPrefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return allowed ? value : fallback;
}

export function currentListLocation(pathname: string, search: string): string {
  return `${pathname}${search}`;
}
