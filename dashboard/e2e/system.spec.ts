import { test, expect } from '@playwright/test';
import { gotoDashboard } from './helpers';

/**
 * System health is operator-only (gated on ADMIN_EMAIL server-side). The admin
 * defaults to ADMIN_EMAIL, so this run exercises the operator path: the System
 * nav item is present and the page shows its health tiles + "Run now".
 *
 * LIMITATION: the dashboard has no self-serve second-account/role signup flow,
 * so the negative case (a non-admin NOT seeing the System nav) is asserted at
 * the API-authorization layer rather than by logging in as a separate user.
 */
test.beforeEach(async ({ page }) => {
  await gotoDashboard(page);
});

test('admin sees the System nav, health tiles, and a Run now button', async ({ page }) => {
  // The server reports this account as the operator.
  const authRes = await page.request.get('/api/system/authorized');
  expect((await authRes.json()).admin).toBe(true);

  // The System link is added to the sidebar only for the operator.
  await expect(page.getByRole('link', { name: 'System' })).toBeVisible();
  await page.getByRole('link', { name: 'System' }).click();
  await page.waitForURL('**/dashboard/system');

  await expect(page.getByRole('heading', { name: 'System Health' })).toBeVisible();
  // Health tiles render (reconciler live view).
  await expect(page.getByText('Healthy assets')).toBeVisible();
  await expect(page.getByText('Missing objects')).toBeVisible();

  // The operator can trigger a reconciliation run.
  const runNow = page.getByRole('button', { name: /run now/i });
  await expect(runNow).toBeVisible();
  await expect(runNow).toBeEnabled();
});

test('the System page is not treated as operator-only forbidden for the admin', async ({ page }) => {
  await page.goto('/dashboard/system');
  // The admin must NOT hit the "Operator access only" gate.
  await expect(page.getByText(/operator access only/i)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'System Health' })).toBeVisible();
});
