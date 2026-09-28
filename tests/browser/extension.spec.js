const { test, expect } = require('./fixtures');

test('MV3 service worker starts', async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
  expect(context.serviceWorkers().length).toBeGreaterThan(0);
});

test('popup loads from extension package', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page).toHaveTitle(/BLB|Blue Letter Bible/i);
  await expect(page.locator('body')).toBeVisible();
});

test.describe('core user-visible E2E', () => {
  test('Show on BLB opens an exact selected reference', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-reference';
      el.textContent = 'John 3:16';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    const popupPromise = context.waitForEvent('page');
    await button.click();
    const blb = await popupPromise;
    expect(new URL(blb.url()).pathname).toMatch(/^\\/kjv\\/(?:john|jhn)\\/3\\/16\\/?$/i);
  });

  test('Double-click opens an exact selected reference', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true, doubleClickBlbSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-reference';
      el.textContent = 'John 3:16';
      document.body.appendChild(el);
    });
    const reference = page.locator('#blb-e2e-reference');
    const popupPromise = context.waitForEvent('page');
    await reference.dblclick();
    const blb = await popupPromise;
    expect(new URL(blb.url()).pathname).toMatch(/^\\/kjv\\/(?:john|jhn)\\/3\\/16\\/?$/i);
  });
});
