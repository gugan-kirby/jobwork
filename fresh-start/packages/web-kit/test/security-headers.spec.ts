import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  originOf,
  staticSecurityHeaders,
} from '../src/security-headers';

/** F-FE.6: the response policy doc 11 §10 asks for, asserted directive by directive. */

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((directive) => {
      const [name, ...values] = directive.split(' ');
      return [name!, values];
    }),
  );
}

const production = { nonce: 'bm9uY2U=', development: false, secureTransport: true, connectOrigins: ['https://store.example'] };

describe('contentSecurityPolicy', () => {
  it('lets a script run only by this response’s nonce, never inline', () => {
    const scripts = directives(contentSecurityPolicy(production)).get('script-src')!;
    expect(scripts).toContain("'nonce-bm9uY2U='");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it('lets this origin\'s service worker and manifest load, which strict-dynamic would otherwise refuse (F-11.6)', () => {
    const policy = directives(contentSecurityPolicy(production));
    expect(policy.get('worker-src')).toEqual(["'self'"]);
    expect(policy.get('manifest-src')).toEqual(["'self'"]);
  });

  it('allows eval only under next dev', () => {
    const scripts = directives(contentSecurityPolicy({ ...production, development: true })).get('script-src')!;
    expect(scripts).toContain("'unsafe-eval'");
  });

  it('cannot be framed, cannot load plugins, cannot rebase or post elsewhere', () => {
    const policy = directives(contentSecurityPolicy(production));
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
  });

  it('lets the browser reach the object store that upload grants point at, and nothing else', () => {
    expect(directives(contentSecurityPolicy(production)).get('connect-src')).toEqual(["'self'", 'https://store.example']);
  });

  it('upgrades subresources only when the response came over HTTPS', () => {
    expect(directives(contentSecurityPolicy(production)).has('upgrade-insecure-requests')).toBe(true);
    expect(
      directives(contentSecurityPolicy({ ...production, secureTransport: false })).has('upgrade-insecure-requests'),
    ).toBe(false);
  });
});

describe('staticSecurityHeaders', () => {
  it('sends nosniff, frame denial, a referrer policy, a permissions policy and COOP', () => {
    const headers = new Map(staticSecurityHeaders().map(({ key, value }) => [key, value]));
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toContain('camera=(self)');
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });
});

describe('originOf', () => {
  it('reduces a configured endpoint to its origin', () => {
    expect(originOf('http://localhost:9000')).toBe('http://localhost:9000');
    expect(originOf('https://store.example/bucket/path')).toBe('https://store.example');
  });
});
