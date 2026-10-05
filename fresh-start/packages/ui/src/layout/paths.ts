/**
 * Active-route matching shared by the header navigation and the bottom tab bar, so the
 * two can never disagree about which item the reader is on. Compared by path prefix;
 * the root matches only itself, otherwise every page would light "Home".
 */
export function isActivePath(currentPath: string | undefined, href: string): boolean {
  if (!currentPath) return false;
  if (href === '/') return currentPath === '/';
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

/**
 * The one item to light among several: the most specific match. A section home such as
 * `/supplier` prefixes its own pages (`/supplier/orders`), so prefix matching alone would
 * light both.
 */
export function activeHref(currentPath: string | undefined, hrefs: readonly string[]): string | undefined {
  return hrefs.filter((href) => isActivePath(currentPath, href)).sort((a, b) => b.length - a.length)[0];
}
