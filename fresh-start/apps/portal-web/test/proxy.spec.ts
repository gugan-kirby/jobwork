// @vitest-environment node
import { NextRequest } from 'next/server';
// The 16.3 docs call this `unstable_doesProxyMatch`; 16.3.4 ships it under its middleware-era name.
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from '../proxy';

/** F-FE.6: every page response carries its own nonce policy; Next can read it back. */

function nonceOf(policy: string | null): string {
  const match = policy?.match(/'nonce-([^']+)'/);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe('proxy', () => {
  it('sets the policy on the response and hands the same policy to the renderer', () => {
    const response = proxy(new NextRequest('http://localhost:3002/orders'));
    const policy = response.headers.get('content-security-policy');
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain('connect-src \'self\' http://localhost:9000');
    // NextResponse.next({ request }) forwards overridden request headers this way; it is
    // how the renderer finds the nonce to stamp on its scripts.
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonceOf(policy));
  });

  it('mints a fresh nonce for every response', () => {
    const first = nonceOf(proxy(new NextRequest('http://localhost:3002/')).headers.get('content-security-policy'));
    const second = nonceOf(proxy(new NextRequest('http://localhost:3002/')).headers.get('content-security-policy'));
    expect(first).not.toBe(second);
  });

  it('adds HSTS and upgrades subresources only behind HTTPS', () => {
    const plain = proxy(new NextRequest('http://localhost:3002/'));
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    expect(plain.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');

    const tls = proxy(new NextRequest('http://portal.internal/', { headers: { 'x-forwarded-proto': 'https' } }));
    expect(tls.headers.get('strict-transport-security')).toContain('max-age=63072000');
    expect(tls.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
  });

  it('runs for pages, not for the API proxy, build assets or router prefetches', () => {
    const matches = (url: string, headers?: Record<string, string>): boolean =>
      unstable_doesMiddlewareMatch({ config, nextConfig: {}, url, ...(headers ? { headers } : {}) });
    expect(matches('/orders')).toBe(true);
    expect(matches('/')).toBe(true);
    expect(matches('/api/v1/orders')).toBe(false);
    expect(matches('/_next/static/chunks/app.js')).toBe(false);
    expect(matches('/orders', { 'next-router-prefetch': '1' })).toBe(false);
  });
});
