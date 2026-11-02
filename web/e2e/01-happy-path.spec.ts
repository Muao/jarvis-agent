import { expect, test } from '@playwright/test';

// The whole engine runs for real; only `claude` is the fake (ADR-0013). Specs 01..05 share one engine and
// database, so they run in file order and the first task is always T-1.
test('message to draft PR: chat, approval, tasks, task detail', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/chat$/);

  await page.getByRole('textbox', { name: 'Message' }).fill('Add an About page to the web app');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page).toHaveURL(/\/chat\/.+/);
  const thread = page.getByRole('main');
  await expect(thread.getByText('Add an About page to the web app').first()).toBeVisible();
  await expect(thread.getByLabel('Jarvis').getByText('On it: T-1 is started.')).toBeVisible();

  const decision = thread.getByRole('article', { name: 'Decision for T-1' });
  await expect(decision).toBeVisible();
  await decision.getByRole('button', { name: 'Approve' }).click();
  await expect(decision.getByText('Approved')).toBeVisible();

  const status = thread.getByRole('article', { name: 'Status of T-1' });
  await expect(status.getByText('PR Open')).toBeVisible();

  const result = thread.getByRole('article', { name: 'Result of T-1' });
  await expect(result).toBeVisible();
  await expect(result.getByRole('link', { name: /Open PR/ })).toHaveAttribute(
    'href',
    'https://github.com/example/repo/pull/7',
  );

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks' }).click();
  const row = page.getByRole('row', { name: /T-1/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('PR Open')).toBeVisible();

  await row.getByRole('link', { name: 'T-1' }).click();
  await expect(page).toHaveURL(/\/tasks\/T-1/);
  const tabs = page.getByRole('tablist', { name: 'Artifacts' });
  for (const name of ['context.md', 'spec.md', 'plan.md', 'tasks.md']) {
    await expect(tabs.getByRole('tab', { name })).toBeVisible();
  }
  await tabs.getByRole('tab', { name: 'spec.md' }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('An About page at /about.')).toBeVisible();
  await expect(panel.getByRole('table')).toBeVisible();
  await expect(panel.getByRole('cell', { name: '/about' })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'worker' }).first()).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Task journal' }).getByRole('listitem'),
  ).not.toHaveCount(0);
});
