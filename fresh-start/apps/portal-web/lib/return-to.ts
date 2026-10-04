'use client';

/**
 * A return path is a URL a page was handed by another page, so it is treated as
 * untrusted input: only a same-origin, absolute path comes back. `//host` and
 * `https://host` are rejected — a "back to your enquiry" link must never be able to
 * carry someone off this origin.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}
