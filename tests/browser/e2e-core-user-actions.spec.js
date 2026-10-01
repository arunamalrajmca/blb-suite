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
  test('Alt+B command path opens an exact selected Bible reference', async ({ page, extensionStorage, extensionWorker }) => {
    await extensionStorage.set({ masterEnabled: true });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-alt-b';
      el.textContent = 'John 3:16';
      el.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const command = await extensionWorker.evaluate(() => {
      const manifest = chrome.runtime.getManifest();
      return manifest.commands?.['open-bible-selection-in-blb'] || null;
    });
    expect(command?.suggested_key?.default).toBe('Alt+B');

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      if (!tab?.id) throw new Error('No active tab for Alt+B command-path E2E');
      await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        world: 'ISOLATED',
        func: () => new Promise(resolve => {
          chrome.runtime.sendMessage({type:'blbSuiteOpenCurrentSelection'}, () => resolve());
        })
      });
    });

    const blb = await waitForTab(extensionWorker, tab => {
      try {
        return new URL(tab.url).hostname === 'www.blueletterbible.org'
          && new URL(tab.url).pathname === '/kjv/jhn/3/16/';
      } catch (_) {
        return false;
      }
    });

    expect(new URL(blb.url).pathname).toBe('/kjv/jhn/3/16/');
    await removeTabById(extensionWorker, blb.id);
  });

  test('copying selected Bible text injects a BLB hyperlink into HTML clipboard data', async ({ page, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    await page.goto('https://www.blueletterbible.org/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-e2e-copy';
      el.textContent = 'John 3:16';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.evaluate(() => {
      window.__blbE2ECopy = { html: null, plain: null };
      document.addEventListener('copy', event => {
        if (!event.clipboardData) return;
        window.__blbE2ECopy.html = event.clipboardData.getData('text/html');
        window.__blbE2ECopy.plain = event.clipboardData.getData('text/plain');
      }, true);
    });

    await page.keyboard.press('Control+c');

    const captured = await page.evaluate(() => window.__blbE2ECopy);
    expect(captured.plain).toBe('John 3:16');
    expect(captured.html).toContain('blueletterbible.org');
    expect(captured.html).toMatch(/kjv\/jhn\/3\/16/i);
  });

  test('BLB verse links inside parse popups open in a new tab', async ({ page, context, extensionStorage }) => {
    await extensionStorage.set({ masterEnabled: true });
    await page.goto('https://www.blueletterbible.org/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'parse-popup';
      popup.innerHTML = '<a id="blb-e2e-popup-link" href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a>';
      document.body.appendChild(popup);
    });

    const link = page.locator('#blb-e2e-popup-link');
    await expect(link).toHaveAttribute('data-blb-suite-popup', '1');

    const newPagePromise = context.waitForEvent('page', { timeout: 10000 });
    await link.click();
    const newPage = await newPagePromise;
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});

    expect(new URL(newPage.url()).hostname).toBe('www.blueletterbible.org');
    expect(new URL(newPage.url()).pathname).toBe('/kjv/jhn/3/16/');
    await newPage.close();
  });

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
