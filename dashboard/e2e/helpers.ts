import { Page, expect } from '@playwright/test';

/**
 * Shared E2E helpers + credentials.
 *
 * Credentials default to the repo .env's admin account so the suite runs
 * against a freshly-installed dev stack with no extra env. Override with
 * E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD / E2E_ADMIN_NAME in CI.
 */
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@example.com';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'QPoeK8j0tiGsUCwBziBtNKHO';
export const ADMIN_NAME = process.env.E2E_ADMIN_NAME || 'Admin';

/** Where the shared authenticated session is stored (see auth.setup.ts). */
export const ADMIN_STATE = 'playwright/.auth/admin.json';

/** Open the dashboard as the already-authenticated admin (storageState-backed). */
export async function gotoDashboard(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
}

/** A collision-resistant name for created resources. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
}

/**
 * Ensure an admin account exists. First-run installs expose /api/setup with
 * needsSetup:true; we create the admin through the setup form so later logins
 * succeed. A no-op once any account exists.
 */
export async function completeSetupIfNeeded(page: Page): Promise<void> {
  let needsSetup = false;
  try {
    const res = await page.request.get('/api/setup');
    const data = await res.json();
    needsSetup = !!data.needsSetup;
  } catch {
    needsSetup = false;
  }
  if (!needsSetup) return;

  await page.goto('/setup');
  await page.getByLabel('Name').fill(ADMIN_NAME);
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.waitForURL(/\/login/);
}

/** Fill and submit the login form (does not wait for navigation). */
export async function submitLogin(
  page: Page,
  email: string = ADMIN_EMAIL,
  password: string = ADMIN_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
}

/** Full path to a logged-in dashboard as the admin operator. */
export async function loginAsAdmin(page: Page): Promise<void> {
  await completeSetupIfNeeded(page);
  await submitLogin(page);
  await page.waitForURL('**/dashboard');
  // The signed-in sidebar shows the admin's email — a stable post-login signal
  // that does not depend on the overview page's conditional sections.
  await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
}

/**
 * Create a project through the UI and open it. Returns the project name.
 * Leaves the browser on the project's overview page.
 */
export async function createProject(page: Page, name = uniqueName('e2e-proj')): Promise<string> {
  await page.goto('/dashboard/projects');
  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);

  // Submit and capture the create response so we can open the project by id —
  // this avoids depending on the (paginated) list re-render to find its card.
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/projects') && r.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: 'Create', exact: true }).click(),
  ]);
  expect(resp.ok(), `project create failed (${resp.status()})`).toBeTruthy();
  const created = await resp.json();
  const id: string = created.id;
  expect(id, 'create response should include the project id').toBeTruthy();

  await page.goto(`/dashboard/projects/${id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return name;
}
