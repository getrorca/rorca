import { NextResponse, type NextRequest } from 'next/server';

const INSTALLER_HOSTS = new Set(['get.rorca.app', 'get.rorca.ai']);

export function proxy(request: NextRequest) {
  const host = request.headers.get('host')?.split(':')[0]?.toLowerCase();

  if (host && INSTALLER_HOSTS.has(host) && request.nextUrl.pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = '/install.sh';
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/',
};
