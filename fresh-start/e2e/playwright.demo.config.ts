import { defineConfig } from '@playwright/test';

/**
 * The customer demo (e2e/demo): the customer portal on a phone, slow and captioned, for a
 * client. Same servers as the full portal walk, from a fresh jobwork_e2e. Run after
 * `pnpm -r build`:
 *
 *   pnpm --filter @jobwork/e2e demo          # films the scenes
 *   pnpm --filter @jobwork/e2e demo:video    # e2e/videos/customer-demo.mp4
 *
 * FW_REUSE=1 reuses servers already running. Locally E2E_CHANNEL=chrome uses the installed Chrome.
 */
const root = '..';
const channel = process.env.E2E_CHANNEL;
const reuse = process.env.FW_REUSE === '1';
const e2eDatabase = new URL(process.env.DATABASE_URL ?? 'postgres://localhost:5432/jobwork_dev');
e2eDatabase.pathname = '/jobwork_e2e';
const apiEnv = {
  DATABASE_URL: e2eDatabase.toString(),
  SESSION_SECRET: 'e2e-session-secret-value',
  SERVICE_TOKEN_SECRET: 'e2e-service-token-secret',
  RATE_LIMIT_MODE: 'off',
  PORTAL_URL: 'http://localhost:3002',
  OPERATIONS_URL: 'http://localhost:3001',
};

export default defineConfig({
  testDir: './demo',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  outputDir: './demo-results',
  reporter: [['list'], ['json', { outputFile: 'demo-results/results.json' }]],
  use: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    video: { mode: 'on', size: { width: 390, height: 844 } },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: 'walk-setup', testDir: '.', testMatch: /(tests\/world\.setup|walk\/staff\.setup)\.ts$/, use: { video: 'off' } },
    { name: 'demo', dependencies: reuse ? [] : ['walk-setup'], testMatch: /demo\/.*\.spec\.ts$/ },
  ],
  webServer: [
    {
      command: reuse ? 'node apps/api/dist/main.js' : 'node e2e/scripts/prepare-db.mjs && node apps/api/dist/main.js',
      cwd: root,
      url: 'http://localhost:4000/api/v1/health',
      reuseExistingServer: reuse,
      timeout: 180_000,
      env: apiEnv,
    },
    {
      // The scan pipeline, the outbox and notifications; the walk uploads real files.
      command: 'node apps/worker/dist/main.js',
      cwd: root,
      url: 'http://localhost:9465/metrics',
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: { ...apiEnv, METRICS_PORT: '9465', API_URL: 'http://localhost:4000', OUTBOX_POLL_MS: '500' },
    },
    { command: 'pnpm --filter @jobwork/portal-web exec next start -p 3002', cwd: root, url: 'http://localhost:3002/login', reuseExistingServer: reuse, timeout: 120_000 },
    { command: 'pnpm --filter @jobwork/operations-web exec next start -p 3001', cwd: root, url: 'http://localhost:3001/login', reuseExistingServer: reuse, timeout: 120_000 },
  ],
});
