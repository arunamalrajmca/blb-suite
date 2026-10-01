const { test, expect } = require('./fixtures');

async function waitForTab(extensionWorker, predicate, timeout = 10000) {
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

async function removeTabById(extensionWorker, id) {
  if (id == null) return;
  await extensionWorker.evaluate((tabId) => chrome.tabs.remove(tabId).catch(() => {}), id);
}

test.describe('core user-action E2E coverage', () => {
  test('selection containing a reference and authored prose opens MultiVerse and Criteria Search', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-paragraph-two-tab';
      el.textContent = 'Philippians 2:12 and John 3:16 — free gift';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();

    const multiVerse = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && url.pathname === '/tools/MultiVerse.cfm';
      } catch (_) {
        return false;
      }
    });

    const criteria = await waitForTab(extensionWorker, tab => {
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org'
          && url.pathname === '/search/search.cfm'
          && (url.searchParams.get('Criteria') || '').toLowerCase().includes('free gift');
      } catch (_) {
        return false;
      }
    });

    expect(new URL(multiVerse.url).pathname).toBe('/tools/MultiVerse.cfm');
    expect(new URL(criteria.url).searchParams.get('Criteria').toLowerCase()).toContain('free gift');

    await removeTabById(extensionWorker, multiVerse.id);
    await removeTabById(extensionWorker, criteria.id);
  });
});
