import type { NextConfig } from 'next';
import { staticSecurityHeaders } from '@jobwork/web-kit';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  transpilePackages: ['@jobwork/ui', '@jobwork/contracts', '@jobwork/web-kit'],
  async headers() {
    // Headers that never vary (doc 11 §10, F-FE.6). The per-response nonce policy and
    // HSTS are set in proxy.ts.
    return [{ source: '/(.*)', headers: staticSecurityHeaders() }];
  },
  async rewrites() {
    // Same-origin proxy to the API keeps session cookies first-party (doc 20 §6).
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
};

export default nextConfig;
