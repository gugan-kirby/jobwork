/** The API Worker as a web Worker's service binding presents it (ADR-0009). */
export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/** Whether the browser asked for the API: the same paths the Node apps' rewrite proxied. */
export function isApiRequest(url: URL): boolean {
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

/**
 * Sends a browser's `/api/*` request to the API Worker through its service binding
 * (F-CW.6), as the Node rewrite proxy did: same path, method, headers and body, so the
 * session cookie stays first-party (doc 20 §6). The browser's address goes in
 * `X-Forwarded-For` from the edge's `CF-Connecting-IP`; anything the browser put there
 * itself is dropped, so per-address limits count browsers, not claims (F-11.2).
 */
export function forwardToApi(request: Request, api: ServiceBinding): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('x-forwarded-for');
  const client = request.headers.get('cf-connecting-ip');
  if (client) headers.set('x-forwarded-for', client);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return api.fetch(
    new Request(request.url, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: 'manual',
      // A streamed body needs this in Node; Workers accept and ignore it.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit),
  );
}
