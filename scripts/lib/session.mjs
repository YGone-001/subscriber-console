/*
 * Session helper for acceptance suites that drive the SPA in a real browser.
 *
 * A suite that audits or screenshots the authenticated console must establish its own
 * session. When it does not, the app parks on the login page and the suite silently
 * measures the wrong surface: the accessibility walkthrough, for example, reported
 * "0 violations" for nine routes while never leaving /login, and its command-palette
 * steps failed because the login page has no palette. The failures looked like product
 * bugs; the real defect was that the suite never authenticated.
 *
 * Explicit tokens still win - pass `--token=` or `UI_*_TOKEN` when a suite must run as a
 * specific principal. This helper is the fallback that makes the default invocation
 * meaningful.
 */
import { loadEnv } from './load-env.mjs';

const DEFAULT_API = 'http://127.0.0.1:18888';

/**
 * POSTs to the auth endpoint and returns the `auth_token` cookie value, or an empty
 * string when the service is unreachable or the credentials are rejected.
 */
export async function obtainAuthToken({ api = DEFAULT_API, username, password } = {}) {
  /* loadEnv writes into process.env and returns nothing. */
  loadEnv(process.cwd());
  const resolvedUser = username?.trim() || process.env.INITIAL_ADMIN_USERNAME?.trim() || 'admin';
  const resolvedPassword = password || process.env.INITIAL_ADMIN_PASSWORD;

  if (!resolvedPassword) return '';

  try {
    const response = await fetch(`${api}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: resolvedUser, password: resolvedPassword }),
    });
    if (!response.ok) return '';

    /* Node exposes getSetCookie(); fall back to the raw header for older runtimes. */
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];

    for (const cookie of cookies) {
      const match = /(?:^|;\s*)auth_token=([^;]+)/.exec(cookie ?? '');
      if (match) return match[1];
    }
    return '';
  } catch {
    return '';
  }
}
