import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')) }));
}

const PAGES = [
  { name: 'Chat', path: '/chat', ready: (p: Page) => p.getByRole('textbox', { name: 'Message' }) },
  { name: 'Tasks', path: '/tasks', ready: (p: Page) => p.getByRole('link', { name: 'T-1' }) },
  {
    name: 'Task detail',
    path: '/tasks/T-1',
    ready: (p: Page) => p.getByRole('tablist', { name: 'Artifacts' }),
  },
  {
    name: 'Overview',
    path: '/overview',
    ready: (p: Page) => p.getByRole('heading', { level: 1, name: 'Overview' }),
  },
];

for (const { name, path, ready } of PAGES) {
  test(`${name} has no serious or critical accessibility violations`, async ({ page }) => {
    await page.goto(path);
    await expect(ready(page)).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('Chat with the navigation collapsed to icons has no serious or critical accessibility violations', async ({
  page,
}) => {
  await page.goto('/chat');
  await expect(page.getByRole('separator', { name: 'Resize thread list' })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Chat' })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});
