import { test, expect } from '@playwright/test';
import { gotoDashboard } from './helpers';

test.beforeEach(async ({ page }) => {
  await gotoDashboard(page);
});

test('lifecycle inbox renders; table or empty state, with an action menu when populated', async ({ page }) => {
  await page.goto('/dashboard/lifecycle');
  await expect(page.getByRole('heading', { name: 'Lifecycle' })).toBeVisible();

  // Header controls are always present.
  await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();
  await expect(page.getByText(/to review/i)).toBeVisible();

  // Wait for loading to settle, then assert exactly one of the two end states.
  await expect(page.getByText('Loading...')).toHaveCount(0);

  const table = page.getByRole('table');
  const emptyState = page.getByText(/nothing to review/i);

  if (await table.count()) {
    await expect(table).toBeVisible();
    // Populated rows expose a per-row action (MoreHorizontal) menu trigger.
    const actionButton = table
      .locator('tbody tr button:has(svg.lucide-ellipsis), tbody tr button:has(svg.lucide-more-horizontal)')
      .first();
    await expect(actionButton).toBeVisible();
    await actionButton.click();
    await expect(page.getByRole('menu')).toBeVisible();
  } else {
    await expect(emptyState).toBeVisible();
  }
});
