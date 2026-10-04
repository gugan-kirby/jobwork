'use client';

import { useEffect, useState } from 'react';

/**
 * A command that succeeded changes counts shown elsewhere on the page — the navigation
 * badges, the bell. `CommandButton` announces each success on `window`; a shell that
 * shows counts depends on `useCommandTick()` and refetches. Without it a badge kept
 * saying "1 waiting" after the person had just decided the only item (IN-12 F-12.4).
 */
export const COMMAND_SUCCEEDED_EVENT = 'jobwork:command-succeeded';

export function announceCommandSucceeded(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMMAND_SUCCEEDED_EVENT));
}

/** Increments after every successful command on this page. */
export function useCommandTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = (): void => setTick((n) => n + 1);
    window.addEventListener(COMMAND_SUCCEEDED_EVENT, bump);
    return () => window.removeEventListener(COMMAND_SUCCEEDED_EVENT, bump);
  }, []);
  return tick;
}
