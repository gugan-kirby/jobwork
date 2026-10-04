import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite's own esbuild transform handles the JSX; the React plugin is only needed for
  // fast refresh, which a test run does not have.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
