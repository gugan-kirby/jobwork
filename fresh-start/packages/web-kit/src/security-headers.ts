/**
 * Response security policy for both Next apps (F-FE.6; doc 11 §10). HttpOnly session
 * cookies keep a script from reading the session (`AUTH-17`); this policy keeps a script
 * from running in the first place (doc 20 §11, "session theft via XSS").
 */

export interface ContentSecurityPolicyOptions {
  /** Fresh per response; Next reads it back from the request's policy and stamps its own scripts. */
  nonce: string;
  /** `next dev` only: React rebuilds server error stacks with `eval`. */
  development: boolean;
  /** The response travels over HTTPS, so subresources must too. */
  secureTransport: boolean;
  /**
   * Origins the browser calls directly besides its own: upload grants PUT straight to
   * the object store (doc 08 §7), so its origin must be reachable.
   */
  connectOrigins?: readonly string[] | undefined;
}

export function contentSecurityPolicy({
  nonce,
  development,
  secureTransport,
  connectOrigins = [],
}: ContentSecurityPolicyOptions): string {
  const directives: Array<[string, ...string[]]> = [
    ['default-src', "'self'"],
    // A script runs only if this response vouches for it by nonce, or a vouched script
    // loaded it. No host allowlist, no 'unsafe-inline'.
    ['script-src', "'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(development ? ["'unsafe-eval'"] : [])],
    // Styles stay inline-capable: React style attributes and the quotation preview's
    // `srcdoc` frame (which inherits this policy) depend on it, and CSS cannot run code.
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'blob:', 'data:'],
    ['font-src', "'self'"],
    ['connect-src', "'self'", ...connectOrigins],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  if (secureTransport) directives.push(['upgrade-insecure-requests']);
  return directives.map((directive) => directive.join(' ')).join('; ');
}

/** Two years, the preload-list minimum; sent only on responses that arrived over HTTPS. */
export const STRICT_TRANSPORT_SECURITY = 'max-age=63072000; includeSubDomains';

/** Headers that do not vary per request, for `next.config` `headers()`. */
export function staticSecurityHeaders(): Array<{ key: string; value: string }> {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // `frame-ancestors 'none'` covers current browsers; this covers the rest.
    { key: 'X-Frame-Options', value: 'DENY' },
    // Record ids live in paths; another origin learns at most which site sent the visitor.
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // Camera stays available to this origin for evidence capture (ADR-0005); the rest is off.
    { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ];
}

/** The origin of a configured URL, for `connect-src`; a malformed value is a deploy error. */
export function originOf(url: string): string {
  return new URL(url).origin;
}
