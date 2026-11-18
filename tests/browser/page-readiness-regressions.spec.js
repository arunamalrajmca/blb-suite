const { test, expect } = require('./fixtures');

async function getTabIdForUrl(extensionWorker, urlPattern) {
  return extensionWorker.evaluate(async pattern => {
    const tabs = await chrome.tabs.query({url:pattern});
    return tabs.find(tab => Number.isInteger(tab.id))?.id ?? null;
  }, urlPattern);
}

async function contentScriptLoaded(extensionWorker, tabId) {
  return extensionWorker.evaluate(async id => {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target:{tabId:id},
        world:'ISOLATED',
        func:() => ({
          fileExecuted:window.__blbSuiteContentScriptFileExecutedV3 === true,
          initialized:window.__blbSuiteContentScriptLoadedV2 === true
        })
      });
      return injection?.result || null;
    } catch (_) {
      return null;
    }
  }, tabId);
}

async function hasBlbPassage(extensionWorker, path) {
  return extensionWorker.evaluate(async expectedPath => {
    const tabs = await chrome.tabs.query({});
    return tabs.some(tab => {
      try {
        const url = new URL(tab.pendingUrl || tab.url || '');
        return url.hostname === 'www.blueletterbible.org' &&
          url.pathname.replace(/\\/+$/, '/') === expectedPath;
      } catch (_) {
        return false;
      }
    });
  }, path);
}

test('first X.com document activates Floating Button and Double-click without a manual reload', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'x.com':true},
    doubleClickBlbSites:{'x.com':true}
  });

  // Keep the test deterministic while retaining the real x.com origin,
  // optional-host permission check, runtime registration, and tabs.onUpdated
  // current-document injection path.
  await page.route('https://x.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>X first-load regression</title></head><body><p id="reference">John 3:16</p></body></html>'
  }));
  await page.goto('https://x.com/', {waitUntil:'domcontentloaded'});

  const tabId = await getTabIdForUrl(extensionWorker, 'https://x.com/*');
  expect(Number.isInteger(tabId)).toBe(true);

  await expect.poll(() => contentScriptLoaded(extensionWorker, tabId), {
    message:'the first x.com document must receive the runtime content-script bundle without reloading'
  }).toMatchObject({fileExecuted:true, initialized:true});

  // Ask the same refresh handshake used by production tab activation to
  // complete both feature gates before exercising the first user gesture.
  const refreshed = await extensionWorker.evaluate(async id =>
    chrome.tabs.sendMessage(id, {type:'blbSuiteRefreshSiteFeatures'}), tabId
  );
  expect(refreshed).toMatchObject({ok:true});

  // Exercise the actual floating action on the first document.
  await page.evaluate(() => {
    const target = document.querySelector('#reference');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
  });
  const floatingButton = page.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible();
  await floatingButton.click();
  await expect.poll(() => hasBlbPassage(extensionWorker, '/kjv/jhn/3/16/')).toBe(true);

  // Exercise Double-click on the same, still-unreloaded x.com document.
  await page.evaluate(() => {
    const target = document.querySelector('#reference');
    target.innerHTML = 'Romans 8:<span id="verse-number">28</span>';
  });
  await page.locator('#verse-number').dblclick();
  await expect.poll(() => hasBlbPassage(extensionWorker, '/kjv/rom/8/28/')).toBe(true);

  expect(await contentScriptLoaded(extensionWorker, tabId)).toMatchObject({
    fileExecuted:true,
    initialized:true
  });
});

test('a BLB link opened in a new tab has its content script on the first load', async ({
  page, context, extensionWorker
}) => {
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>BLB new-tab readiness</title></head><body><a id="new-tab-verse" target="_blank" href="https://www.blueletterbible.org/kjv/rom/8/28/">Romans 8:28</a></body></html>'
  }));

  await page.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', {waitUntil:'domcontentloaded'});
  const popupPromise = context.waitForEvent('page');
  await page.locator('#new-tab-verse').click();
  const newTab = await popupPromise;
  await newTab.waitForLoadState('domcontentloaded');

  const newTabId = await getTabIdForUrl(
    extensionWorker,
    'https://www.blueletterbible.org/kjv/rom/8/28/*'
  );
  expect(Number.isInteger(newTabId)).toBe(true);

  await expect.poll(() => contentScriptLoaded(extensionWorker, newTabId), {
    message:'a BLB destination opened in a new tab must initialize the extension without a manual reload'
  }).toMatchObject({fileExecuted:true, initialized:true});

  // Verify the destination remains usable in that original new-tab document.
  await expect(newTab.locator('#new-tab-verse')).toBeVisible();
  expect(newTab.url()).toContain('/kjv/rom/8/28/');
});
