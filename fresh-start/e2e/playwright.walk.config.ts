import { defineConfig } from '@playwright/test';

/**
 * FW full portal walk: every screen and command of the operations, customer and supplier
 * portals, recorded. Each test is one actor on one portal; `scripts/stitch-videos.mjs`
 * joins the clips into one mp4 per portal plus the whole run. Run after `pnpm -r build`:
 *
 *   pnpm --filter @jobwork/e2e walk          # boots API, worker and both apps on a fresh jobwork_e2e
 *   pnpm --filter @jobwork/e2e walk:videos   # e2e/videos/*.mp4
 *
 * FW_REUSE=1 reuses servers already running (iterating on one chapter; records from earlier
 * runs stay, every chapter builds its own). Locally E2E_CHANNEL=chrome uses the installed Chrome.
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
  testDir: './walk',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: './walk-results',
  reporter: [['list'], ['html', { outputFolder: 'walk-report', open: 'never' }], ['json', { outputFile: 'walk-results/results.json' }]],
  use: {
    viewport: { width: 1280, height: 800 },
    // FW_MOBILE=1: the phone-sized customer cut (see walk/support/walk.ts).
    video: { mode: 'on', size: process.env.FW_MOBILE === '1' ? { width: 780, height: 1688 } : { width: 1280, height: 800 } },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: 'walk-setup', testDir: '.', testMatch: /(tests\/world\.setup|walk\/staff\.setup)\.ts$/, use: { video: 'off' } },
    { name: 'walk', dependencies: reuse ? [] : ['walk-setup'], testMatch: /(\d\d|zz)-.*\.spec\.ts$/ },
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
