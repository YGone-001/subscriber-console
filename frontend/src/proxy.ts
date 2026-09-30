import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Next.js UI navigation guard.
 *
 * Responsibility boundary after Phase 8.5:
 *   - Nginx owns /api and /api/* routing (every API request goes straight to Go).
 *   - Go owns API authentication, authorization and current-account/session validation.
 *   - This module owns protected UI *navigation* protection only.
 *
 * It therefore never decodes a JWT, never verifies HS256, never reads MongoDB,
 * never constructs trusted identity headers and never forwards an API request.
 * The only authority it consults is the Go authentication service, and it does so
 * with nothing but the incoming auth_token cookie.
 */

const GO_BACKEND_URL = process.env.GO_BACKEND_URL || 'http://127.0.0.1:18888';
const AUTH_AUTHORITY_TIMEOUT_MS = 5000;

/** Fail-closed page response when the authentication authority cannot answer. */
function failClosed(code: 'AUTH_UNAVAILABLE' | 'AUTH_SERVICE_UNAVAILABLE', detail: string): NextResponse {
  const response = NextResponse.json({ error: detail, code }, { status: 503 });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** Ask Go for the authoritative identity behind the incoming auth_token cookie. */
async function askGoAuthMe(cookieHeader: string): Promise<number | null> {
  try {
    const response = await fetch(new URL('/api/auth/me', GO_BACKEND_URL), {
      method: 'GET',
      headers: { cookie: cookieHeader },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(AUTH_AUTHORITY_TIMEOUT_MS),
    });
    return response.status;
  } catch {
    // Transport failure: the authentication authority is unreachable.
    return null;
  }
}

function loginRedirect(request: NextRequest, clearCookie: boolean): NextResponse {
  const target = new URL('/login', request.url);
  target.searchParams.set('from', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.redirect(target);
  if (clearCookie) response.cookies.delete('auth_token');
  return response;
}

export async function proxy(request: NextRequest) {
  const token = request.cookies.get('auth_token')?.value;
  const isLoginRoute = request.nextUrl.pathname === '/login';

  // No credential at all: the page guard decides without disturbing Go.
  if (!token) {
    if (isLoginRoute) return NextResponse.next();
    return loginRedirect(request, false);
  }

  const authorityStatus = await askGoAuthMe(request.headers.get('cookie') || `auth_token=${token}`);

  if (authorityStatus === 200) {
    // Authoritative session is valid.
    if (isLoginRoute) return NextResponse.redirect(new URL('/', request.url));
    return NextResponse.next();
  }

  if (authorityStatus === 401) {
    // Authoritative authentication failure (invalid, revoked, disabled, locked, role mismatch).
    if (isLoginRoute) {
      const response = NextResponse.next();
      response.cookies.delete('auth_token');
      return response;
    }
    return loginRedirect(request, true);
  }

  if (authorityStatus === 503) {
    // Go is alive but its session authority is temporarily unavailable.
    // Never turn this into a successful render and never invalidate the cookie.
    return failClosed('AUTH_UNAVAILABLE', 'Authentication temporarily unavailable');
  }

  // Unreachable or unexpected authority answer: fail closed without local fallback.
  return failClosed('AUTH_SERVICE_UNAVAILABLE', 'Authentication service unavailable');
}

export const config = {
  // /api is owned by the edge + Go; this guard must never see an API request.
  matcher: ['/((?!api|_next/static|_next/image|images/|favicon.ico).*)'],
};
