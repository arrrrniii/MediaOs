import { test, expect } from '@playwright/test';
import { gotoDashboard, uniqueName } from './helpers';

test.beforeEach(async ({ page }) => {
  await gotoDashboard(page);
});

test('create, list, open, edit a setting, and delete a project', async ({ page }) => {
  const name = uniqueName('e2e-lifecycle');
  const renamed = `${name}-renamed`;

  // ── Create ────────────────────────────────────────────────
  await page.goto('/dashboard/projects');
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Description').fill('created by an e2e test');
  await dialog.getByRole('button', { name: 'Create' }).click();

  // ── Listed ────────────────────────────────────────────────
  const card = page.getByRole('link').filter({ hasText: name });
  await expect(card).toBeVisible();

  // ── Open ──────────────────────────────────────────────────
  await card.click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  // ── Change a setting (rename) ─────────────────────────────
  await page.getByRole('link', { name: 'Settings' }).click();
  const nameInput = page.getByLabel('Name');
  await expect(nameInput).toHaveValue(name);
  await nameInput.fill(renamed);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  // ── Delete (type-to-confirm + alert dialog) ───────────────
  // The confirm input carries the project name as its placeholder.
  await page.getByPlaceholder(renamed, { exact: true }).fill(renamed);
  await page.getByRole('button', { name: 'Delete Project' }).click();
  await page.getByRole('button', { name: /yes, delete everything/i }).click();

  // Back on the projects list, the card is gone.
  await page.waitForURL('**/dashboard/projects');
  await expect(page.getByRole('link').filter({ hasText: renamed })).toHaveCount(0);
});
