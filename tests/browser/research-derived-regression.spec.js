const { test, expect } = require('./fixtures');
const fs = require('fs');
const path = require('path');

const genericPageHtml = fs.readFileSync(
  path.resolve(__dirname, '../pages/extension-test.html'),
  'utf8'
);

async function waitForTab(extensionWorker, predicate, timeout = 10000) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() =>
      chrome.tabs.query({}).then(items =>
        items.map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '' }))
      )
    );
    match = tabs.find(predicate) || null;
    return !!match;
  }, { timeout }).toBeTruthy();
  return match;
}

async function removeTabById(extensionWorker, id) {
  if (id == null) return;
  await extensionWorker.evaluate(tabId =>
    chrome.tabs.remove(tabId).catch(() => {}), id);
}

async function loadGenericExtensionPage(page, extensionStorage) {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true }
  });
  await page.route('https://example.com/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: genericPageHtml
    });
  });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
}

async function selectNodeAndNotify(page, id) {
  await page.evaluate(nodeId => {
    const node = document.getElementById(nodeId);
    if (!node) throw new Error('Missing test node: ' + nodeId);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, id);
}

async function openSelectedReferenceViaPageButton(page, extensionWorker, expectedPath) {
  const button = page.locator('#blb-suite-page-selection-button');
  await expect(button).toBeVisible({ timeout: 10000 });
  await button.click();
  return expectSingleVerseTab(extensionWorker, expectedPath);
}

async function expectSingleVerseTab(extensionWorker, expectedPath) {
  const tab = await waitForTab(extensionWorker, candidate => {
    try {
      const url = new URL(candidate.url);
      return url.hostname === 'www.blueletterbible.org' &&
        url.pathname === expectedPath;
    } catch (_) {
      return false;
    }
  });
  expect(new URL(tab.url).pathname).toBe(expectedPath);
  return tab;
}

test.describe('research-derived DOM/reference regression coverage', () => {
  test('D19 split/decorated reference resolves through the existing selection action', async ({
    page, extensionStorage, extensionWorker
  }) => {
    await loadGenericExtensionPage(page, extensionStorage);
    await selectNodeAndNotify(page, 'case-split');
    const tab = await openSelectedReferenceViaPageButton(page, extensionWorker, '/kjv/jhn/3/16/');
    expect(new URL(tab.url).pathname).toBe('/kjv/jhn/3/16/');
    await removeTabById(extensionWorker, tab.id);
  });

  test('D20 dynamically inserted reference remains actionable after DOM mutation', async ({
    page, extensionStorage, extensionWorker
  }) => {
    await loadGenericExtensionPage(page, extensionStorage);
    await page.locator('#insert-dynamic').click();
    await expect(page.locator('#dynamic-target')).toContainText('John 3:16');

    await page.evaluate(() => {
      const node = document.querySelector('#dynamic-target span');
      if (!node) throw new Error('Missing dynamically inserted reference');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const tab = await openSelectedReferenceViaPageButton(page, extensionWorker, '/kjv/jhn/3/16/');
    expect(new URL(tab.url).pathname).toBe('/kjv/jhn/3/16/');
    await removeTabById(extensionWorker, tab.id);
  });

  test('D21 selection inside a positioned overlay resolves normally', async ({
    page, extensionStorage, extensionWorker
  }) => {
    await loadGenericExtensionPage(page, extensionStorage);

    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'research-overlay';
      overlay.style.cssText =
        'position:fixed;left:80px;top:80px;z-index:2147483646;' +
        'background:white;border:1px solid #999;padding:20px;';
      overlay.innerHTML =
        '<div class="target" id="overlay-reference"><span>John</span> <strong>3:16</strong></div>';
      document.body.appendChild(overlay);
    });

    await selectNodeAndNotify(page, 'overlay-reference');
    const tab = await openSelectedReferenceViaPageButton(page, extensionWorker, '/kjv/jhn/3/16/');
    expect(new URL(tab.url).pathname).toBe('/kjv/jhn/3/16/');
    await removeTabById(extensionWorker, tab.id);
  });

  test('D22 inverted selection still resolves the selected Bible reference', async ({
    page, extensionStorage, extensionWorker
  }) => {
    await loadGenericExtensionPage(page, extensionStorage);

    await page.evaluate(() => {
      const node = document.getElementById('case-inverted');
      if (!node) throw new Error('Missing inverted-selection case');

      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.collapse(range.endContainer, range.endOffset);
      selection.extend(range.startContainer, range.startOffset);

      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const tab = await openSelectedReferenceViaPageButton(page, extensionWorker, '/kjv/jhn/3/16/');
    await removeTabById(extensionWorker, tab.id);
  });

  test('D23 adjacent numbered-book references resolve independently', async ({
    page, extensionStorage, extensionWorker
  }) => {
    await loadGenericExtensionPage(page, extensionStorage);

    await page.evaluate(() => {
      const node = document.getElementById('case-adjacent');
      if (!node) throw new Error('Missing adjacent numbered-book case');

      const text = node.firstChild;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 10);

      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const firstTab = await openSelectedReferenceViaPageButton(page, extensionWorker, '/kjv/1jo/5/3/');
    expect(new URL(firstTab.url).pathname).toBe('/kjv/1jo/5/3/');
    await removeTabById(extensionWorker, firstTab.id);

    await page.evaluate(() => {
      const node = document.getElementById('case-adjacent');
      const text = node.firstChild;
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(text, 12);
      range.setEnd(text, 20);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const secondTab = await openSelectedReferenceViaPageButton(page, extensionWorker, '/kjv/2jo/4/');
    expect(new URL(secondTab.url).pathname).toBe('/kjv/2jo/4/');
    await removeTabById(extensionWorker, secondTab.id);
  });
});
