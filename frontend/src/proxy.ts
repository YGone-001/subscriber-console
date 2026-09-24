import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getJwtSecretKey } from '@/lib/security';
import { AccountSessionError, validateCurrentAccount } from '@/lib/accountSession';
import { resolveRouteOwner } from '@/lib/cutover-routing';

const JWT_SECRET = getJwtSecretKey();

/**
 * Forward an authenticated request to the Go backend.
 * The Go backend performs its own JWT verification from the auth_token cookie.
 * Cookies and body are forwarded; auth headers are set by the Node proxy.
 */
async function forwardToGo(request: NextRequest, requestHeaders: Headers): Promise<Response> {
  const backendUrl = process.env.GO_BACKEND_URL || 'http://127.0.0.1:18888';
  const goUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, backendUrl);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const bodyBuffer = hasBody && request.body ? await request.arrayBuffer() : undefined;

  // Forward original request with cookies and body.
  // Go middleware extracts auth_token cookie independently.
  const goRequest = new Request(goUrl.toString(), {
    method: request.method,
    headers: requestHeaders,
    body: bodyBuffer,
  });

  let goResponse: Response;
  try {
    goResponse = await fetch(goRequest);
  } catch (err) {
    // Go backend unreachable — return 502, do NOT fall back to Node.
    // Single-writer invariant: owner=go means only Go may execute.
    // Rollback: change owner in cutover-routing.ts to 'node'.
    console.error('[cutover] Go backend unreachable:', request.method, request.nextUrl.pathname, err);
    return NextResponse.json(
      { error: 'Backend temporarily unavailable', code: 'GO_BACKEND_UNREACHABLE' },
      { status: 502 }
    );
  }

  // Build response for the browser — preserve Go's status, headers, body.
  const responseHeaders = new Headers(goResponse.headers);
  // Remove hop-by-hop headers that should not be forwarded
  responseHeaders.delete('transfer-encoding');
  responseHeaders.delete('connection');

  return new Response(goResponse.body, {
    status: goResponse.status,
    statusText: goResponse.statusText,
    headers: responseHeaders,
  });
}

export async function proxy(request: NextRequest) {
  const token = request.cookies.get('auth_token')?.value;

  const isAuthRoute = request.nextUrl.pathname.startsWith('/login');
  const isPublicApiRoute = request.nextUrl.pathname === '/api/auth/login' || request.nextUrl.pathname === '/api/auth/logout';
  const isPublicImage = request.nextUrl.pathname.startsWith('/images/');

  if (isPublicImage || request.nextUrl.pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  if (isPublicApiRoute) {
    const owner = resolveRouteOwner(request.method, request.nextUrl.pathname);
    if (owner === 'go') {
      console.log(JSON.stringify({
        level: 'info',
        msg: 'cutover_forward',
        method: request.method,
        path: request.nextUrl.pathname,
        owner: 'go',
        principal: 'anonymous',
      }));
      return await forwardToGo(request, new Headers(request.headers));
    }
    return NextResponse.next();
  }

  const isApiRoute = request.nextUrl.pathname.startsWith('/api/');

  if (!token) {
    if (isAuthRoute) return NextResponse.next();
    if (isApiRoute) {
      const res = NextResponse.json({ error: 'Unauthorized', code: 'AUTH_INVALID_TOKEN' }, { status: 401 });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'], requiredClaims: ['exp'] });
    // Next 16 Proxy runs on Node.js. Validate every protected request against MongoDB.
    const account = await validateCurrentAccount({ username: payload.username, role: payload.role, sv: payload.sv });
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-user', account.username);
    requestHeaders.set('x-user-role', account.role);
    requestHeaders.set('x-user-id', account.userId);
    requestHeaders.set('x-user-session-version', String(account.sessionVersion));

    // ── Controlled Single-Writer Cutover ──────────────────────────
    // For routes owned by Go, forward the authenticated request to Go :18888.
    // Go performs its own JWT verification; single-writer invariant is preserved.
    // Rollback: change owner in cutover-routing.ts from 'go' to 'node'.
    if (isApiRoute) {
      const owner = resolveRouteOwner(request.method, request.nextUrl.pathname);
      if (owner === 'go') {
        console.log(JSON.stringify({
          level: 'info',
          msg: 'cutover_forward',
          method: request.method,
          path: request.nextUrl.pathname,
          owner: 'go',
          principal: account.username,
        }));
        return await forwardToGo(request, requestHeaders);
      }
    }

    if (isAuthRoute) {
      return NextResponse.redirect(new URL('/', request.url));
    }

    return NextResponse.next({
        request: {
            headers: requestHeaders,
        }
    });
  } catch (error) {
    const code = error instanceof AccountSessionError ? error.code : 'AUTH_INVALID_TOKEN';
    const isAuthError = error instanceof AccountSessionError || (error instanceof Error && error.name.startsWith('JWT')) || (error instanceof Error && error.name.startsWith('JWS'));
    if (!isAuthError) {
      const res = NextResponse.json({ error: 'Authentication temporarily unavailable', code: 'AUTH_UNAVAILABLE' }, { status: 503 });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (isAuthRoute) return NextResponse.next();

    if (isApiRoute) {
      const response = NextResponse.json({ error: 'Unauthorized', code }, { status: 401 });
      response.headers.set('Cache-Control', 'no-store');
      response.cookies.delete('auth_token');
      return response;
    }

    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('auth_token');
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|images/|favicon.ico).*)'],
}
