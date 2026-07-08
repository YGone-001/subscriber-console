import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getJwtSecretKey } from '@/lib/security';

const JWT_SECRET = getJwtSecretKey();

export async function proxy(request: NextRequest) {
  const token = request.cookies.get('auth_token')?.value;

  const isAuthRoute = request.nextUrl.pathname.startsWith('/login');
  const isPublicApiRoute = request.nextUrl.pathname === '/api/auth/login' || request.nextUrl.pathname === '/api/auth/logout';

  if (isPublicApiRoute || request.nextUrl.pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  const isApiRoute = request.nextUrl.pathname.startsWith('/api/');

  if (!token) {
    if (isAuthRoute) return NextResponse.next();
    if (isApiRoute) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.redirect(new URL('/login', request.url));
  }

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-user', payload.username as string);
    requestHeaders.set('x-user-role', (payload.role as string) || 'viewer');

    if (isAuthRoute) {
      return NextResponse.redirect(new URL('/', request.url));
    }

    return NextResponse.next({
        request: {
            headers: requestHeaders,
        }
    });
  } catch {
    if (isAuthRoute) return NextResponse.next();

    if (isApiRoute) {
      const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      response.cookies.delete('auth_token');
      return response;
    }

    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('auth_token');
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
