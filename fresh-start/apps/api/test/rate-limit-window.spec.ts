import { describe, expect, it } from 'vitest';
import { estimate, retryAfterMs } from '../src/platform/http/rate-limit/window';

const W = 60_000;

/**
 * F-11.2: a `Retry-After` is a promise. Each expected wait is worked by hand, then
 * checked by replaying the estimate at that instant: one more request must fit.
 */
describe('sliding-window retry guidance (F-11.2)', () => {
  function fits(previous: number, current: number, limit: number, elapsed: number, wait: number): boolean {
    const at = elapsed + wait;
    return at < W ? estimate(previous, current + 1, at, W) <= limit + 1e-9 : estimate(current, 1, at - W, W) <= limit + 1e-9;
  }

  it('waits for the previous window to decay when the current one still has room', () => {
    // 10 last minute, 3 this minute, half-way through, limit 5: 10 × (1 − t) + 4 ≤ 5 at t = 0.9.
    expect(retryAfterMs(10, 3, 5, 30_000, W)).toBeCloseTo(24_000, 3);
    expect(fits(10, 3, 5, 30_000, 24_000)).toBe(true);
    expect(fits(10, 3, 5, 30_000, 23_000)).toBe(false);
  });

  it('carries over into the next window when this one is full', () => {
    // 6 this minute against 5: next minute, 6 × (1 − t) + 1 ≤ 5 at t = 1/3 → 50 s from now.
    expect(retryAfterMs(0, 6, 5, 30_000, W)).toBeCloseTo(50_000, 3);
    expect(fits(0, 6, 5, 30_000, 50_001)).toBe(true);
    expect(fits(0, 6, 5, 30_000, 31_000)).toBe(false);
  });

  it('does not promise the window boundary when the old window still weighs on the new one', () => {
    // Refused 10 s before the boundary with 3 against a limit of 2: the boundary is not enough.
    const wait = retryAfterMs(0, 3, 2, 50_000, W);
    expect(wait).toBeGreaterThan(10_000);
    expect(fits(0, 3, 2, 50_000, wait)).toBe(true);
    expect(fits(0, 3, 2, 50_000, 10_000)).toBe(false);
  });

  it('waits out both windows for a budget of one', () => {
    expect(retryAfterMs(1, 1, 1, 0, W)).toBe(2 * W);
  });
});
