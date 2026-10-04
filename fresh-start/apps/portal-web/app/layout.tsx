import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import '@jobwork/ui/tokens.css';
import '@jobwork/ui/base.css';
import brand from '@jobwork/ui/brand.json';
import { PortalShell } from './shell';

export const metadata: Metadata = {
  title: 'JobWork',
  description: 'Managed custom-manufacturing procurement',
  // F-11.6: iOS reads its own tags for an installed web app, not the manifest.
  appleWebApp: { capable: true, title: 'JobWork', statusBarStyle: 'default' },
};

// `viewport-fit=cover` lets the tab bar pad itself above the home indicator (F-MX.2).
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: brand.themeColor };

const environment =
  process.env.NODE_ENV === 'production' ? null : (process.env.NODE_ENV ?? 'development');

export default async function RootLayout({ children }: { children: ReactNode }) {
  // F-FE.6: the CSP nonce is minted per request, so every page renders at request time.
  // Nothing is lost: each page is personalised in the browser and was a static spinner.
  await connection();
  return (
    <html lang="en">
      <body>
        <PortalShell environmentLabel={environment ? `${environment} environment` : null}>
          {children}
        </PortalShell>
      </body>
    </html>
  );
}
