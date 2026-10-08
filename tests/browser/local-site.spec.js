const { test, expect } = require('./fixtures');

const LOCAL_SITE_URL = process.env.BLB_LOCAL_SITE_URL || 'http://bible.localhost:8000';

async function selectExactText(page, text) {
  const selected = await page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = node.nodeValue || '';
      const index = value.indexOf(wanted);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + wanted.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    }
    return '';
  }, text);
  expect(selected).toBe(text);
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
}

async function waitForBlbTab(extensionWorker, predicate, timeout = 10000) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '' }))
    ));
    match = tabs.find(predicate) || null;
    return !!match;
  }, { timeout }).toBeTruthy();
  return match;
}

async function removeMatchingBlbTabs(extensionWorker, expectedPath) {
  await extensionWorker.evaluate((path) => chrome.tabs.query({}).then(async tabs => {
    for (const tab of tabs) {
      try {
        const url = new URL(String(tab.url || tab.pendingUrl || ''));
        if (url.hostname === 'www.blueletterbible.org' &&
            (url.pathname === path || url.pathname.startsWith(path.replace(/\/$/, '') + '/')) &&
            tab.id != null) await chrome.tabs.remove(tab.id);
      } catch (_) {}
    }
  }), expectedPath);
}

test.describe('local Bible-site E2E', () => {
  test.beforeEach(async ({ extensionStorage, page }) => {
    const hostname = new URL(LOCAL_SITE_URL).hostname;
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { [hostname]: true },
      doubleClickBlbSites: { [hostname]: true }
    });
    await page.goto(LOCAL_SITE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
  });

  test('Show on BLB operates on the real local Bible page', async ({ page, extensionWorker }) => {
    await selectExactText(page, 'John 3:16');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();

    const tab = await waitForBlbTab(extensionWorker, candidate => {
      try {
        const url = new URL(candidate.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/jhn/3/16/';
      } catch (_) { return false; }
    });
    expect(new URL(tab.url).pathname).toBe('/kjv/jhn/3/16/');
    await removeMatchingBlbTabs(extensionWorker, '/kjv/jhn/3/16/');
  });

  test('Alt+B operates on the real local Bible page', async ({ page, extensionWorker }) => {
    await selectExactText(page, 'John 3:16');
    await page.keyboard.press('Alt+b');

    const tab = await waitForBlbTab(extensionWorker, candidate => {
      try {
        const url = new URL(candidate.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/jhn/3/16/';
      } catch (_) { return false; }
    });
    expect(new URL(tab.url).pathname).toBe('/kjv/jhn/3/16/');
    await removeMatchingBlbTabs(extensionWorker, '/kjv/jhn/3/16/');
  });

  test('Double-click operates on the real local Bible page', async ({ page, extensionWorker }) => {
    const target = page.getByText('John 3:16', { exact: false }).first();
    await expect(target).toBeVisible({ timeout: 10000 });
    await target.dblclick();

    const tab = await waitForBlbTab(extensionWorker, candidate => {
      try {
        const url = new URL(candidate.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === '/kjv/jhn/3/16/';
      } catch (_) { return false; }
    });
    expect(new URL(tab.url).pathname).toBe('/kjv/jhn/3/16/');
    await removeMatchingBlbTabs(extensionWorker, '/kjv/jhn/3/16/');
  });
});