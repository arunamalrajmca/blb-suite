const { test, expect } = require('./fixtures');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '../pages/research-derived-smoke.html'), 'utf8');

async function setup(page, storage) {
  await storage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
  await page.route('https://example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toContainText('Research-derived DOM regression fixture');
}

async function selectText(page, id, reverse = false) {
  await page.evaluate(({ id, reverse }) => {
    const node = document.getElementById(id);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (reverse) {
      selection.collapse(range.endContainer, range.endOffset);
      selection.extend(range.startContainer, range.startOffset);
    } else selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, { id, reverse });
}

async function expectBlbPath(worker, pathname) {
  let match;
  await expect.poll(async () => {
    const tabs = await worker.evaluate(() => chrome.tabs.query({}).then(items => items.map(t => ({ id: t.id, url: t.url || t.pendingUrl || '' }))));
    match = tabs.find(t => {
      try { const u = new URL(t.url); return u.hostname === 'www.blueletterbible.org' && u.pathname === pathname; }
      catch (_) { return false; }
    });
    return !!match;
  }, { timeout: 10000 }).toBeTruthy();
  await worker.evaluate(id => chrome.tabs.remove(id).catch(() => {}), match.id);
}

async function useShowOnBlb(page, worker, path) {
  await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
  await page.locator('#blb-suite-page-selection-button').click();
  await expectBlbPath(worker, path);
}

test.describe('research-derived DOM regression smoke', () => {
  test('D19 split inline nodes preserve the selected reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'split');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D20 dynamically inserted reference remains actionable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await page.evaluate(() => {
      const node = document.getElementById('dynamic');
      node.innerHTML = '<span>John</span> <strong>3:16</strong>';
    });
    await selectText(page, 'dynamic');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D21 selection inside a positioned overlay resolves', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;left:60px;top:60px;z-index:2147483646;background:white;padding:20px';
      overlay.id = 'overlay';
      overlay.innerHTML = '<span>John</span> <strong>3:16</strong>';
      document.body.appendChild(overlay);
    });
    await selectText(page, 'overlay');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D22 reversed selection preserves the Bible reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'reverse', true);
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D23 adjacent numbered-book references resolve independently', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await page.evaluate(() => {
      const node = document.getElementById('adjacent');
      const text = node.firstChild;
      const start = text.textContent.indexOf('1 John 5:3');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + '1 John 5:3'.length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await useShowOnBlb(page, extensionWorker, '/kjv/1jo/5/3/');
    await page.evaluate(() => {
      const node = document.getElementById('adjacent');
      const text = node.firstChild;
      const start = text.textContent.indexOf('2 John 4');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + '2 John 4'.length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await useShowOnBlb(page, extensionWorker, '/kjv/2jo/1/4/');
  });

  test('D25a line break between book and chapter/verse remains resolvable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'linebreak');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D25b non-breaking space between book and chapter/verse remains resolvable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'nbsp');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D25c repeated spaces between book and chapter/verse remain resolvable', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'repeated-space');
    await useShowOnBlb(page, extensionWorker, '/kjv/jhn/3/16/');
  });

  test('D16 numeric prose is not treated as a direct Bible-verse reference', async ({ page, extensionStorage, extensionWorker }) => {
    await setup(page, extensionStorage);
    await selectText(page, 'numeric-prose');

    const before = await extensionWorker.evaluate(() =>
      chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
    );

    try {
      await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({ timeout: 10000 });
      await page.locator('#blb-suite-page-selection-button').click();
      await page.waitForTimeout(1500);

      const directVerseTabs = await extensionWorker.evaluate(beforeIds =>
        chrome.tabs.query({}).then(tabs => tabs.filter(tab => {
          if (beforeIds.includes(tab.id)) return false;
          try {
            const url = new URL(tab.url || tab.pendingUrl || '');
            return url.hostname === 'www.blueletterbible.org' &&
              /^\/kjv\/[^/]+\/\d+\/\d+\/?$/.test(url.pathname);
          } catch (_) {
            return false;
          }
        }).map(tab => ({ id: tab.id, url: tab.url || tab.pendingUrl || '' })),
      before);

      expect(directVerseTabs, 'numeric prose must not open a direct verse destination').toEqual([]);
    } finally {
      await extensionWorker.evaluate(beforeIds =>
        chrome.tabs.query({}).then(tabs => Promise.all(tabs
          .filter(tab => !beforeIds.includes(tab.id) && (() => {
            try { return new URL(tab.url || tab.pendingUrl || '').hostname === 'www.blueletterbible.org'; }
            catch (_) { return false; }
          })())
          .map(tab => chrome.tabs.remove(tab.id).catch(() => {})))),
      before);
    }
  });

});
