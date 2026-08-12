import { defineConfig, devices } from '@playwright/test';

/**
 * MediaOS dashboard E2E config.
 *
 * The stack (worker on :3000, dashboard on :3001, Postgres/MinIO/Redis) is
 * assumed to be started EXTERNALLY — by CI or by a local `npm run dev` — so
 * there is no `webServer` block here. Point the suite at a running dashboard
 * with E2E_BASE_URL (default http://localhost:3001).
 *
 * Credentials come from E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, defaulting to the
 * repo .env's ADMIN_EMAIL / ADMIN_PASSWORD so `npm run e2e` works against a
 * freshly-installed dev stack with no extra configuration.
 *
 * To run:
 *   npx playwright install chromium         # once, to fetch the browser
 *   E2E_BASE_URL=http://localhost:3001 \
 *   E2E_ADMIN_EMAIL=admin@example.com \
 *   E2E_ADMIN_PASSWORD=... \
 *   npm run e2e
 */
export default defineConfig({
  testDir: './e2e',
  // Specs share one admin account and mutate server state (projects, keys), so
  // run files serially by default to keep assertions deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // Authenticate once; the result is reused by the storageState below.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },

    // The login/logout FLOWS are tested here with a fresh (unauthenticated)
    // session — no shared storageState.
    {
      name: 'chromium-auth',
      testMatch: [/setup\.spec\.ts/, /auth\.spec\.ts/],
      use: { ...devices['Desktop Chrome'] },
    },

    // Everything else starts already signed in via the saved session, so the
    // suite makes only a handful of real logins (staying under the worker's
    // login rate limit) and runs faster.
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: [/setup\.spec\.ts/, /auth\.spec\.ts/, /auth\.setup\.ts/],
      use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/admin.json' },
    },

    // Uncomment to broaden coverage once chromium is green in CI.
    // { name: 'firefox', dependencies: ['setup'], use: { ...devices['Desktop Firefox'], storageState: 'playwright/.auth/admin.json' } },
    // { name: 'webkit', dependencies: ['setup'], use: { ...devices['Desktop Safari'], storageState: 'playwright/.auth/admin.json' } },
  ],
});
