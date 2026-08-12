import { test, expect } from '@playwright/test';
import { gotoDashboard, createProject, uniqueName } from './helpers';

test.beforeEach(async ({ page }) => {
  await gotoDashboard(page);
});

test('create an API key, reveal it once, then revoke it', async ({ page }) => {
  await createProject(page);
  // The project nav tab (exact "API Keys") — the overview also has a "Manage API Keys" link.
  await page.getByRole('link', { name: 'API Keys', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();

  const keyName = uniqueName('e2e-key');

  // ── Create ────────────────────────────────────────────────
  // The header trigger and the dialog submit are both "Create Key"; open with
  // the first, then submit from within the dialog.
  await page.getByRole('button', { name: 'Create Key' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(keyName);
  await dialog.getByRole('button', { name: 'Create Key' }).click();

  // The one-time secret is shown; it uses the mv_ prefix.
  const secret = dialog.locator('code').first();
  await expect(secret).toBeVisible();
  await expect(secret).toContainText(/^mv_/);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // ── Listed in the table ───────────────────────────────────
  const row = page.getByRole('row').filter({ hasText: keyName });
  await expect(row).toBeVisible();
  // Masked prefix by default (ends with an ellipsis).
  await expect(row.locator('code').first()).toContainText('...');

  // ── Reveal (icon-only eye button in the row) ──────────────
  await row.locator('button:has(svg.lucide-eye)').click();
  await expect(row.locator('code').first()).toContainText(/^mv_/);

  // ── Revoke (trash → confirm) ──────────────────────────────
  await row.locator('button:has(svg.lucide-trash-2)').click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('Key revoked')).toBeVisible();
  await expect(row.getByText('revoked')).toBeVisible();
});
