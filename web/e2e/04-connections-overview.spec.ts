import { expect, test } from '@playwright/test';

test('connections page renders', async ({ page }) => {
  await page.goto('/connections');
  await expect(page.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
});

test('overview says Jarvis is idle once the flow is finished', async ({ page }) => {
  await page.goto('/overview');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Jarvis is idle' })).toBeVisible();
});
