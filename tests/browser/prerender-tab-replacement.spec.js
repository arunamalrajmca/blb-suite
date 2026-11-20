const { test, expect } = require('./fixtures');

test('Chromium prerender activation emits a real tabs.onReplaced event and initializes the surviving document', async ({
  context, extensionStorage, extensionWorker, extensionId
}) => {
  test.setTimeout(90000);
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{'example.com':true}
  });

  const page = await context.newPage();
  await page.goto('https://example.com/?blb-prerender-source=1', {waitUntil:'domcontentloaded'});
  const sourceTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
    if (!tab || !Number.isInteger(tab.id)) throw new Error('Unable to identify source tab');
    globalThis.__blbPrerenderReplacementEvents = [];
    chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
      globalThis.__blbPrerenderReplacementEvents.push({
        addedTabId, removedTabId, observedAt:Date.now()
      });
    });
    return tab.id;
  });

  const browser = context.browser();
  expect(browser, 'Chromium browser must expose a browser-level CDP session').not.toBeNull();
  const cdp = await browser.newBrowserCDPSession();
  const statuses = [];
  const statusListener = event => {
    if (event.url && event.url.includes('blb-prerender-destination=1')) {
      statuses.push({
        status:event.status,
        url:event.url,
        prerenderingAttemptId:event.prerenderingAttemptId
      });
    }
  };

  try {
    await cdp.send('Preload.enable');
    cdp.on('Preload.prerenderStatusUpdated', statusListener);

    const destination = 'https://example.com/?blb-prerender-destination=1';
    await page.evaluate(url => {
      const rules = {
        prerender:[{
          source:'list',
          urls:[url],
          eagerness:'immediate'
        }]
      };
      const script = document.createElement('script');
      script.type = 'speculationrules';
      script.textContent = JSON.stringify(rules);
      document.head.appendChild(script);
    }, destination);

    await expect.poll(() => statuses.some(item => item.status === 'Ready'), {
      timeout:20000,
      message:'Chromium must report the destination prerender as Ready before activation'
    }).toBe(true);

    // A normal same-tab navigation activates the browser-created prerender.
    await page.evaluate(url => { window.location.href = url; }, destination);
    await page.waitForURL(destination, {timeout:15000});
    await page.waitForLoadState('domcontentloaded');

    await expect.poll(() => statuses.some(item => item.status === 'Activated'), {
      timeout:10000,
      message:'Chromium must report the prerender as Activated'
    }).toBe(true);

    await expect.poll(() => extensionWorker.evaluate(() =>
      globalThis.__blbPrerenderReplacementEvents || []
    ), {
      timeout:10000,
      message:'The extension must receive the real chrome.tabs.onReplaced event'
    }).toEqual(expect.arrayContaining([
      expect.objectContaining({removedTabId:sourceTabId})
    ]));

    const replacementEvents = await extensionWorker.evaluate(() =>
      globalThis.__blbPrerenderReplacementEvents || []
    );
    const replacement = replacementEvents.find(event => event.removedTabId === sourceTabId);
    expect(replacement).toBeTruthy();
    expect(replacement.addedTabId).not.toBe(sourceTabId);

    await expect.poll(() => extensionWorker.evaluate(async tabId => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return tab ? {id:tab.id,url:tab.url,status:tab.status} : null;
    }, replacement.addedTabId), {
      timeout:10000,
      message:'The replacement tab must remain live at the prerendered destination'
    }).toMatchObject({
      id:replacement.addedTabId,
      url:destination,
      status:'complete'
    });

    await expect.poll(() => extensionWorker.evaluate(async tabId => {
      const results = await chrome.scripting.executeScript({
        target:{tabId},
        world:'ISOLATED',
        func:() => ({
          fileExecuted:!!globalThis.__blbSuiteContentScriptFileExecutedV3,
          initialized:!!globalThis.__blbSuiteContentScriptLoadedV2,
          doubleClickBound:!!globalThis.__blbSuiteDoubleClickBoundV2
        })
      }).catch(() => []);
      return results[0]?.result || null;
    }, replacement.addedTabId), {
      timeout:15000,
      message:'The surviving prerendered document must execute and initialize the extension content script'
    }).toMatchObject({
      fileExecuted:true,
      initialized:true,
      doubleClickBound:true
    });
  } finally {
    cdp.off('Preload.prerenderStatusUpdated', statusListener);
    await cdp.detach().catch(() => {});
    await page.close().catch(() => {});
    await extensionStorage.set({
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{'example.com':false}
    });
    await extensionWorker.evaluate(() =>
      reconcileRuntimeContentScriptRegistrations().catch(() => {})
    );
  }
});
