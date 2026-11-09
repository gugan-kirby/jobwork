import { describe, expect, it } from 'vitest';
import { forwardToApi, isApiRequest } from '../src/edge';

function recorder(): { binding: { fetch(request: Request): Promise<Response> }; seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    binding: {
      fetch: async (request) => {
        seen.push(request);
        return new Response('{"ok":true}', { status: 201, headers: { 'set-cookie': 'jw_session=abc; Path=/; HttpOnly' } });
      },
    },
  };
}

describe('API forwarding at the edge (F-CW.6)', () => {
  it('takes the API paths only', () => {
    expect(isApiRequest(new URL('https://portal.test/api/v1/auth/me'))).toBe(true);
    expect(isApiRequest(new URL('https://portal.test/api'))).toBe(true);
    expect(isApiRequest(new URL('https://portal.test/apiary'))).toBe(false);
    expect(isApiRequest(new URL('https://portal.test/enquiries'))).toBe(false);
  });

  it('passes method, path, cookies and body through, and the reply back unchanged', async () => {
    const { binding, seen } = recorder();
    const res = await forwardToApi(
      new Request('https://portal.test/api/v1/auth/login?x=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'jw_csrf=t', origin: 'https://portal.test' },
        body: '{"email":"a@b.test"}',
      }),
      binding,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toContain('jw_session=abc');
    const sent = seen[0]!;
    expect(sent.method).toBe('POST');
    expect(new URL(sent.url).pathname + new URL(sent.url).search).toBe('/api/v1/auth/login?x=1');
    expect(sent.headers.get('cookie')).toBe('jw_csrf=t');
    expect(sent.headers.get('origin')).toBe('https://portal.test');
    expect(await sent.text()).toBe('{"email":"a@b.test"}');
  });

  it('names the browser from the edge, never from what the browser claims', async () => {
    const { binding, seen } = recorder();
    await forwardToApi(
      new Request('https://portal.test/api/v1/public/categories', {
        headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.1, 1.2.3.4' },
      }),
      binding,
    );
    expect(seen[0]!.headers.get('x-forwarded-for')).toBe('203.0.113.9');

    await forwardToApi(new Request('https://portal.test/api/v1/public/categories', { headers: { 'x-forwarded-for': '1.2.3.4' } }), binding);
    expect(seen[1]!.headers.get('x-forwarded-for')).toBeNull();
  });
});
