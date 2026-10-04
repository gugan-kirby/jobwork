import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import '@jobwork/ui/tokens.css';
import '@jobwork/ui/base.css';
import { OperationsShell } from './shell';

export const metadata: Metadata = {
  title: 'JobWork Operations',
  description: 'JobWork internal operations',
};

const environment =
  process.env.NODE_ENV === 'production' ? null : (process.env.NODE_ENV ?? 'development');

export default async function RootLayout({ children }: { children: ReactNode }) {
  // F-FE.6: the CSP nonce is minted per request, so every page renders at request time.
  // Nothing is lost: each page is personalised in the browser and was a static spinner.
  await connection();
  return (
    <html lang="en">
      {/* DS-02: operations is dense by default. */}
      <body className="density-compact">
        <OperationsShell
          environmentLabel={environment ? `${environment} environment — operations` : null}
        >
          {children}
        </OperationsShell>
      </body>
    </html>
  );
}
