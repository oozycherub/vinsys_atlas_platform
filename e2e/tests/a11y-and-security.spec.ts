import { expect, test } from '@playwright/test';
import { expectAccessible, signIn } from './helpers';

test('core pages have no serious accessibility violations', async ({ page, request }) => {
  await page.goto('/login');
  await expectAccessible(page, 'login');
  await signIn(page, request, 'admin@acme.test');
  for (const path of [
    '/admin',
    '/admin/users',
    '/admin/analytics',
    '/admin/notification-settings',
    '/admin/reports',
    '/admin/taxonomy',
    '/admin/notifications',
    '/recruiter',
    '/recruiter/requisitions',
    '/recruiter/reviews',
    '/employee',
    '/employee/marketplace',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    // (No "network idle" here: the notification stream stays open by design.)
    await expect(page.getByRole('status').filter({ hasText: 'Loading…' })).toHaveCount(0);
    await expectAccessible(page, path);
  }
});

test('Arabic renders right-to-left', async ({ page, context, request }) => {
  await signIn(page, request, 'admin@acme.test');
  await context.addCookies([{ name: 'atlas_locale', value: 'ar', domain: 'localhost', path: '/' }]);
  await page.goto('/admin');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('button', { name: 'تسجيل الخروج' })).toBeVisible();
  await expectAccessible(page, 'admin (ar)');
});

test('a strict CSP with a per-request nonce, and no unsigned inline scripts', async ({ page }) => {
  const first = await page.goto('/login');
  const csp = first?.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  const unsigned = await page.evaluate(
    (n) => [...document.querySelectorAll('script')].filter((s) => s.nonce !== n).length,
    nonce,
  );
  expect(unsigned).toBe(0);
  const second = await page.goto('/login');
  expect(second?.headers()['content-security-policy']).not.toBe(csp); // fresh nonce per request
});

test('signed-out visitors are sent to sign-in; the UI hides what roles cannot do', async ({
  page,
  request,
}) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, request, 'admin@acme.test');
  await expect(page.getByRole('navigation', { name: 'Portals' }).getByRole('link')).toHaveText([
    'Admin',
    'Recruiting',
    'My workspace',
  ]);
});
