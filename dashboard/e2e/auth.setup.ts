import { test as setup, expect } from '@playwright/test';
import { completeSetupIfNeeded, submitLogin, ADMIN_EMAIL, ADMIN_STATE } from './helpers';

/**
 * Authenticate ONCE and persist the session. The authenticated specs reuse this
 * storage state (see playwright.config.ts) instead of logging in per-test —
 * that keeps the run fast and, importantly, under the worker's login rate limit
 * (LOGIN_RATE_LIMIT, default 10 per IP/email per window). The login/logout
 * flows themselves are still exercised for real by auth.spec.ts / setup.spec.ts.
 */
setup('authenticate', async ({ page }) => {
  await completeSetupIfNeeded(page);
  await submitLogin(page);
  await page.waitForURL('**/dashboard');
  await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
  await page.context().storageState({ path: ADMIN_STATE });
});
