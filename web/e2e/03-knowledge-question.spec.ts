import { expect, test } from '@playwright/test';

test('a question gets a Jarvis answer and creates no task', async ({ page }) => {
  await page.goto('/chat');
  await page
    .getByRole('textbox', { name: 'Message' })
    .fill('What does the About page spec say about routing?');
  await page.getByRole('button', { name: 'Send' }).click();

  const thread = page.getByRole('main');
  await expect(
    thread.getByLabel('Jarvis').getByText('The About page lives at /about and is a static route.'),
  ).toBeVisible();
  await expect(thread.getByRole('article', { name: /Status of/ })).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('link', { name: 'T-1' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'T-2' })).toHaveCount(0);
});
