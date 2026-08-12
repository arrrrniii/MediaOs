import { test, expect } from '@playwright/test';
import { gotoDashboard, createProject } from './helpers';

// A tiny but valid PNG (4x4, solid) the worker's image pipeline can decode.
const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4IScHRwzEcQCxYxBBO0tjggAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeEach(async ({ page }) => {
  await gotoDashboard(page);
});

test('upload an image, see it in the grid, preview it, and confirm the served URL renders', async ({ page }) => {
  await createProject(page);
  // The project nav tab (exact "Files") — the overview also has an "Upload Files" link.
  await page.getByRole('link', { name: 'Files', exact: true }).click();
  await expect(page.getByText(/drop files here or click to upload/i)).toBeVisible();

  // ── Upload via the dropzone's file input ──────────────────
  await page.locator('input[type="file"]').setInputFiles({
    name: 'e2e-pixel.png',
    mimeType: 'image/png',
    buffer: PNG_PIXEL,
  });
  await expect(page.getByText(/file\(s\) uploaded/i)).toBeVisible({ timeout: 30_000 });

  // ── It appears in the file grid ───────────────────────────
  const fileCard = page.locator('button').filter({ has: page.locator('img') }).first();
  await expect(fileCard).toBeVisible({ timeout: 30_000 });

  // ── Open the preview ──────────────────────────────────────
  await fileCard.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // The preview shows a served /f/ URL and the image itself.
  const previewImg = dialog.locator('img').first();
  await expect(previewImg).toBeVisible();
  const src = await previewImg.getAttribute('src');
  expect(src, 'preview image should have a served src URL').toBeTruthy();

  // Confirm the served URL actually returns image bytes (not a 403/404).
  await expect.poll(async () => {
    const res = await page.request.get(src!);
    return res.ok() ? (res.headers()['content-type'] || '') : `status:${res.status()}`;
  }, { timeout: 30_000, message: 'served URL should return an image' }).toContain('image');
});
