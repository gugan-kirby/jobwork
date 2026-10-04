'use client';

import '@jobwork/ui/tokens.css';
import '@jobwork/ui/base.css';
import { RouteError } from '@jobwork/ui';

/**
 * F-FE.5: the last boundary, for a failure in the root layout itself. It replaces the
 * whole document, so it brings its own `<html>`, `<body>` and stylesheets, and has no
 * shell to sit in.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <title>Something went wrong — JobWork</title>
        <main
          id="main"
          style={{
            maxWidth: 'var(--container-narrow)',
            margin: '0 auto',
            padding: 'var(--space-6) var(--space-4)',
          }}
        >
          <RouteError digest={error.digest} onRetry={retry} />
        </main>
      </body>
    </html>
  );
}
