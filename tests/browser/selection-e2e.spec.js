const { test, expect } = require('./fixtures');

async function selectText(page, selector) {
  await page.locator(selector).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
  });
}

async function waitForBlbTab(extensionWorker) {
  await expect.poll(async () => (await extensionWorker.evaluate(async () => chrome.tabs.query({}))).map(t => t.url || t.pendingUrl || ''), { timeout: 30000 }).toContainEqual(expect.stringMatching(/https:\/\/www\.blueletterbible\.org\/kjv\/.*john.*3.*16/i));
}

test.beforeEach(async ({ extensionStorage }) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { '127.0.0.1': true },
    doubleClickBlbSites: { '127.0.0.1': true }
  });
});

test('Show on BLB performs real selection -> button -> BLB navigation', async ({ page, extensionWorker }) => {
  await page.goto('/selection-fixture.html', { waitUntil: 'domcontentloaded' });
  const button = page.locator('#blb-suite-page-selection-button');
  await expect(button).toHaveCount(1);
  await expect(button).toBeHidden();
  await selectText(page, '#reference');
  await expect(button).toBeVisible({ timeout: 10000 });
  await button.click();
  await waitForBlbTab(extensionWorker);
});

test('Double-click performs real selection -> extension handler -> BLB navigation', async ({ page, extensionTabs }) => {
  await page.goto('/selection-fixture.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#blb-suite-page-selection-button')).toHaveCount(1);
  await page.locator('#reference').dblclick();
  await waitForBlbTab(page.context());
});
