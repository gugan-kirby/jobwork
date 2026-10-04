import { NextResponse, type NextRequest } from 'next/server';
import {
  STRICT_TRANSPORT_SECURITY,
  contentSecurityPolicy,
  originOf,
} from '@jobwork/web-kit';

/**
 * F-FE.6: a fresh nonce and Content-Security-Policy per page response (doc 11 §10).
 * Next reads the nonce back from the request's policy header and stamps it on every
 * script it renders, which is why the root layout renders at request time.
 */

// Upload grants are signed against this endpoint; the browser PUTs to it directly.
const OBJECT_STORE_ORIGIN = originOf(process.env.OBJECT_STORE_ENDPOINT ?? 'http://localhost:9000');

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  // Behind a TLS-terminating load balancer the hop to Next is plain HTTP.
  const scheme = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(/:$/, '');
  const secureTransport = scheme === 'https';
  const policy = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === 'development',
    secureTransport,
    connectOrigins: [OBJECT_STORE_ORIGIN],
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  if (secureTransport) response.headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: the API proxy, build assets and icons carry no scripts to vouch for.
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)',
      // Router prefetches fetch payloads, not documents.
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
