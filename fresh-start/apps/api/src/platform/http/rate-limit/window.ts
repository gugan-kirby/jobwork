/**
 * Sliding-window arithmetic (F-11.2). A budget's load is estimated from two fixed windows:
 * `previous × (share of the previous window still inside the sliding one) + current`.
 * Both functions take `current` including the request being judged.
 */

export function estimate(previous: number, current: number, elapsedMs: number, windowMs: number): number {
  return previous * (1 - elapsedMs / windowMs) + current;
}

/**
 * How long until one more request would be allowed, assuming none arrives meanwhile.
 * A `Retry-After` that a polite client honours must be true: "wait for this window to
 * end" is not, because the window that just ended still weighs on the next one.
 */
export function retryAfterMs(previous: number, current: number, limit: number, elapsedMs: number, windowMs: number): number {
  const leftInWindow = windowMs - elapsedMs;
  // Still in this window: the previous window's weight decays until there is room.
  if (previous > 0 && current + 1 <= limit) {
    const wait = windowMs * (1 - (limit - current - 1) / previous) - elapsedMs;
    if (wait < leftInWindow) return Math.max(0, wait);
  }
  // In the next window, this window's count becomes the decaying `previous`.
  if (current + 1 <= limit) return leftInWindow;
  const wait = windowMs * (2 - (limit - 1) / current) - elapsedMs;
  return Math.min(Math.max(wait, leftInWindow), 2 * windowMs - elapsedMs);
}
