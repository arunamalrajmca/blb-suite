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

    // Chromium automation cannot reliably synthesize the browser-level
    // chrome.commands accelerator. Invoke the exact existing Alt+B command
    // implementation through its public runtime message instead of weakening
    // the destination assertion or changing production code.
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
});
