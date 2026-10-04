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
