import { test, expect } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, submitLogin } from './helpers';

/**
 * First-run setup. Resilient to both states:
 *   - fresh install (0 accounts) → /setup creates the initial admin
 *   - already installed          → /setup redirects to /login and we sign in
 * Either way the run ends authenticated on the dashboard.
 */
test('creates the first admin, or logs in if setup is already done', async ({ page }) => {
  const res = await page.request.get('/api/setup');
  const { needsSetup } = await res.json();

  if (needsSetup) {
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: /welcome to mediaos/i })).toBeVisible();
    await page.getByLabel('Name').fill(ADMIN_NAME);
    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /create account/i }).click();
    // Setup hands off to the login page once the account exists.
    await page.waitForURL(/\/login/);
  } else {
    // Setup is closed: visiting it bounces to /login.
    await page.goto('/setup');
    await page.waitForURL(/\/login/);
  }

  await submitLogin(page);
  await page.waitForURL('**/dashboard');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});
