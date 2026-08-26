import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getJwtSecretKey } from '@/lib/security';
import { AccountSessionError, validateCurrentAccount } from '@/lib/accountSession';

const JWT_SECRET = getJwtSecretKey();

export async function proxy(request: NextRequest) {
  const token = request.cookies.get('auth_token')?.value;

  const isAuthRoute = request.nextUrl.pathname.startsWith('/login');
  const isPublicApiRoute = request.nextUrl.pathname === '/api/auth/login' || request.nextUrl.pathname === '/api/auth/logout';
  const isPublicImage = request.nextUrl.pathname.startsWith('/images/');

  if (isPublicApiRoute || isPublicImage || request.nextUrl.pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  const isApiRoute = request.nextUrl.pathname.startsWith('/api/');

  if (!token) {
    if (isAuthRoute) return NextResponse.next();
    if (isApiRoute) return NextResponse.json({ error: 'Unauthorized', code: 'AUTH_INVALID_TOKEN' }, { status: 401 });
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
    if (!isAuthError) return NextResponse.json({ error: 'Authentication temporarily unavailable', code: 'AUTH_UNAVAILABLE' }, { status: 503 });
    if (isAuthRoute) return NextResponse.next();

    if (isApiRoute) {
      const response = NextResponse.json({ error: 'Unauthorized', code }, { status: 401 });
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
