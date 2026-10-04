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
    hookTimeout: 30_000,
  },
});
