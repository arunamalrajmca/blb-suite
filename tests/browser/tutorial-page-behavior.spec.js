const { test, expect } = require('./fixtures');

test('user guide theme preference persists across page reloads', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/Tutorial.html`);
  await page.evaluate(() => localStorage.removeItem('blbSuiteTheme'));
  await page.reload();

  const root = page.locator('html');
  const toggle = page.locator('#themeToggle');
  await expect(root).toHaveAttribute('data-theme', 'dark');

  await toggle.click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveText('🌙 Dark');
  await page.reload();

  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveText('🌙 Dark');
});

test('user guide Run command control routes its example through the extension handler', async ({
  page, context, extensionId, extensionWorker
}) => {
  await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.blueletterbible.org/*' });
    await Promise.all(tabs.map(tab => chrome.tabs.remove(tab.id).catch(() => {})));
  });
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>BLB command fixture</title></head><body>Romans 8:28</body></html>'
  }));

  await page.goto(`chrome-extension://${extensionId}/Tutorial.html`);
  const command = page.locator('td code').filter({ hasText: 'b Romans 8:28' });
  const shell = command.locator('xpath=..');
  const run = shell.getByRole('button', { name: 'Run command' });
  await expect(run).toBeVisible();
  await run.click();

  await expect(page).toHaveURL('https://www.blueletterbible.org/kjv/rom/8/28/', { timeout: 10000 });
});
