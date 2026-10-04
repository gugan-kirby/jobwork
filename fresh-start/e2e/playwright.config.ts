import { defineConfig, devices } from '@playwright/test';

/**
 * IN-12 F-12.4 launch journeys (doc 21 §9). The API starts on a freshly prepared
 * database (`scripts/prepare-db.mjs`), the two web apps from their production builds, on
 * the ports their builds point at, so stop a running dev stack first. Run after
 * `pnpm -r build`:  pnpm --filter @jobwork/e2e e2e
 *
 * Locally E2E_CHANNEL=chrome uses the installed Chrome; CI installs Playwright's Chromium.
 */
const root = '..';
const channel = process.env.E2E_CHANNEL;
// Same server as DATABASE_URL (credentials and all), database jobwork_e2e.
const e2eDatabase = new URL(process.env.DATABASE_URL ?? 'postgres://localhost:5432/jobwork_dev');
e2eDatabase.pathname = '/jobwork_e2e';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: 'setup', testMatch: /world\.setup\.ts/ },
    { name: 'journeys', dependencies: ['setup'], testMatch: /.*\.spec\.ts/, use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) } },
  ],
  webServer: [
    {
      command: 'node e2e/scripts/prepare-db.mjs && node apps/api/dist/main.js',
      cwd: root,
      url: 'http://localhost:4000/api/v1/health',
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        DATABASE_URL: e2eDatabase.toString(),
        SESSION_SECRET: 'e2e-session-secret-value',
        // Sign-ins and commands far beyond one person's budget; limits have their own suite.
        RATE_LIMIT_MODE: 'off',
        PORTAL_URL: 'http://localhost:3002',
        OPERATIONS_URL: 'http://localhost:3001',
      },
    },
    { command: 'pnpm --filter @jobwork/portal-web exec next start -p 3002', cwd: root, url: 'http://localhost:3002/login', reuseExistingServer: false, timeout: 120_000 },
    { command: 'pnpm --filter @jobwork/operations-web exec next start -p 3001', cwd: root, url: 'http://localhost:3001/login', reuseExistingServer: false, timeout: 120_000 },
  ],
});
