import { expect, test } from '@playwright/test';

test('worker session console lists events and expands a tool call', async ({ page }) => {
  await page.goto('/tasks/T-1');
  await page.getByRole('link', { name: 'worker' }).first().click();

  await expect(page).toHaveURL(/\/sessions\/.+/);
  await expect(page.getByRole('heading', { name: /Session/ })).toBeVisible();
  const events = page.getByRole('log', { name: 'Events' });
  await expect(events.getByText('Spec approved, implementing.')).toBeVisible();

  // The console opens on the latest run; the first run (Context) is the one that reads the repo.
  await page.getByRole('combobox', { name: 'Run' }).selectOption({ index: 0 });
  await expect(events.getByText('Reading the repository.')).toBeVisible();
  await expect(events.getByText('Read', { exact: true }).first()).toBeVisible();

  const input = events.getByText('Input', { exact: true }).first();
  await input.click();
  await expect(events.getByText(/"file_path": "AGENTS.md"/)).toBeVisible();
});
