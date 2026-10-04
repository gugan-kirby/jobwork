import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// F-12.4: the Phase 1 load bursts, run by the nightly only (`pnpm perf`).
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['test/perf/**/*.perf.ts'],
      testTimeout: 300_000,
      hookTimeout: 300_000,
    },
  }),
);
