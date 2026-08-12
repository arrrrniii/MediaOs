import { test, expect } from '@playwright/test';
import { completeSetupIfNeeded, submitLogin, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';

test.beforeEach(async ({ page }) => {
  await completeSetupIfNeeded(page);
});

test('valid credentials sign in and land on the dashboard', async ({ page }) => {
  await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL('**/dashboard');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  // The signed-in sidebar shows the admin's email.
  await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
});

test('invalid credentials show an error and stay on /login', async ({ page }) => {
  await submitLogin(page, ADMIN_EMAIL, 'definitely-the-wrong-password');
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('logout returns to the login page', async ({ page }) => {
  await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL('**/dashboard');

  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL(/\/login/);
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
});
