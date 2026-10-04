import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next compiles the app with `jsx: preserve`; under test, Vite's esbuild handles JSX
  // the way `packages/ui` does.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
