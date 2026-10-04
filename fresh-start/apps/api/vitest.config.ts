import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// esbuild cannot emit decorator metadata, which Nest DI requires — transform with SWC instead.
// Server tests boot real Fastify/pg sockets; worker threads abort on teardown, so use forks.
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
  test: {
    pool: 'forks',
    testTimeout: 30_000,
    // Suites sign in hundreds of times from one address; `rate-limit.api.spec.ts` turns
    // limits on for itself (F-11.2).
    env: { RATE_LIMIT_MODE: 'off' },
    hookTimeout: 30_000,
  },
});
