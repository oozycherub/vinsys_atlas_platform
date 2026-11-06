import { type APIRequestContext, type Page, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export const STUB = 'http://127.0.0.1:4010';

/** The stub's "mailbox": what notification-svc would have emailed. */
export async function mailbox(
  request: APIRequestContext,
  email: string,
): Promise<{ kind: string; token: string }> {
  const res = await request.get(`${STUB}/__mailbox?email=${encodeURIComponent(email)}`);
  return (await res.json()) as { kind: string; token: string };
}

export async function signIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your inbox');
  const m = await mailbox(request, email);
  expect(m.kind).toBe('magic_link');
  await page.goto(`/auth/magic?token=${m.token}`);
}

/** Zero serious or critical axe violations (WCAG 2.2 AA rules). */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
}
