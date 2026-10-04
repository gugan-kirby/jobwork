'use client';

import { Page, RouteError } from '@jobwork/ui';

/**
 * F-FE.5: a page that throws while rendering shows a recoverable error inside the shell
 * instead of a blank screen. `retry` (stable since Next 16.3) re-fetches and re-renders
 * the failed segment.
 */
export default function PageError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}): React.JSX.Element {
  return (
    <Page title="Something went wrong" titleHidden width="narrow">
      <RouteError digest={error.digest} onRetry={retry} />
    </Page>
  );
}
