import { expect, test } from '@playwright/test';
import { expectAccessible, mailbox, signIn } from './helpers';

/**
 * invite → login → create assessment → candidate completes a coding test with a network drop →
 * recruiter sees the report (Component Prompt 14 §8).
 */
test('invite, assess with a network drop, and report', async ({ browser, page, request }) => {
  // Admin signs in with a magic link and invites a recruiter.
  await signIn(page, request, 'admin@acme.test');
  await expect(page).toHaveURL(/\/admin$/);
  await expectAccessible(page, 'admin home');
  await page.getByRole('link', { name: 'Users' }).first().click();
  await page.getByLabel('Email').fill('rec@acme.test');
  await page.getByLabel('Role').selectOption('recruiter');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation sent.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'rec@acme.test' })).toBeVisible();
  await expectAccessible(page, 'users');

  // The recruiter accepts the invitation (signs in) and builds a coding assessment.
  const recruiter = await browser.newContext();
  const rec = await recruiter.newPage();
  const invite = await mailbox(request, 'rec@acme.test');
  expect(invite.kind).toBe('invitation');
  await rec.goto(`/invite?token=${invite.token}`);
  await expect(rec).toHaveURL(/\/recruiter$/);
  await expect(rec).not.toHaveURL(/token=/);
  await rec.getByLabel('Title').fill('Python basics');
  await rec.getByLabel('Duration (minutes)').fill('20');
  await rec.getByRole('button', { name: 'Create assessment' }).click();
  await expect(rec.getByRole('heading', { name: 'Python basics' })).toBeVisible();
  await expectAccessible(rec, 'assessment detail');
  await rec.getByRole('button', { name: 'Publish' }).click();
  await rec.getByRole('button', { name: 'Create candidate link' }).click();
  const link = (await rec.getByTestId('candidate-link').textContent()) ?? '';
  expect(link).toMatch(/\/test\/inv_/);

  // The candidate: details, device check, start, code in Monaco, lose the network, keep typing.
  const candidate = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const cand = await candidate.newPage();
  await cand.goto(new URL(link).pathname);
  await cand.getByLabel('Full name').fill('Ada Lovelace');
  await cand.getByLabel('Email').fill('ada@example.test');
  await cand.getByRole('button', { name: 'Continue' }).click();
  await cand.getByRole('button', { name: 'Check camera and microphone' }).click();
  await cand.getByLabel(/I agree to camera/).check();
  await cand.getByRole('button', { name: 'Continue' }).click();
  await expectAccessible(cand, 'runner start');
  await cand.getByRole('button', { name: 'Start the assessment' }).click();
  await expect(cand.getByRole('timer')).toBeVisible();
  const editor = cand.getByTestId('code-editor').locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await cand.keyboard.press('ControlOrMeta+A');
  await cand.keyboard.type('import sys\n');
  await expect(cand.getByTestId('save-status')).toHaveText('All answers saved');

  await candidate.setOffline(true);
  await cand.evaluate(() => window.dispatchEvent(new Event('offline')));
  await cand.keyboard.type('a, b = map(int, sys.stdin.read().split())\nprint(a + b)\n');
  await expect(cand.getByTestId('save-status')).toContainText('You are offline');
  await cand.getByRole('button', { name: 'Submit assessment' }).click();
  await expect(cand.getByText(/will be submitted as soon as you reconnect/)).toBeVisible();
  // The answer survives on the device while offline.
  const queued = await cand.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const r = indexedDB.open('atlas-runner');
        r.onsuccess = () => {
          const q = r.result.transaction('pending-answers').objectStore('pending-answers').count();
          q.onsuccess = () => resolve(q.result);
        };
      }),
  );
  expect(queued).toBe(1);

  await candidate.setOffline(false);
  await cand.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(cand.getByText('Your answers have been submitted')).toBeVisible();

  // The recruiter sees the submission, its score, and downloads the PDF report.
  await rec.reload();
  const row = rec.getByRole('row', { name: /submitted/ });
  await expect(row).toContainText('100%');
  await row.getByRole('button', { name: 'PDF report' }).click();
  const download = rec.getByRole('link', { name: 'Download report' });
  await expect(download).toBeVisible();
  const href = (await download.getAttribute('href')) ?? '';
  const pdf = await rec.request.get(href);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  await recruiter.close();
  await candidate.close();
});
