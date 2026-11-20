const { test, expect } = require('./fixtures');

test('Chromium prerender activation emits a real tabs.onReplaced event and initializes the surviving document', async ({
  context, extensionStorage, extensionWorker
}) => {
  test.setTimeout(90000);
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{'example.com':true}
  });

  const page = await context.newPage();
  try {
    await page.goto('https://example.com/?blb-prerender-source=1', {waitUntil:'domcontentloaded'});
    await page.bringToFront();
    const sourceVisibility = await page.evaluate(() => ({
      visibilityState:document.visibilityState,
      hasFocus:document.hasFocus()
    }));
    expect(sourceVisibility.visibilityState,
      'The source document must be foregrounded before requesting prerender'
    ).toBe('visible');
    expect(sourceVisibility.hasFocus,
      'The source document must own the foreground window before requesting prerender'
    ).toBe(true);

    const sourceTab = await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if (!tab || !Number.isInteger(tab.id)) throw new Error('Unable to identify source tab');
      globalThis.__blbPrerenderReplacementEvents = [];
      chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
        globalThis.__blbPrerenderReplacementEvents.push({
          addedTabId, removedTabId, observedAt:Date.now()
        });
      });
      return {id:tab.id,url:tab.url,active:tab.active};
    });
    expect(sourceTab).toMatchObject({
      url:'https://example.com/?blb-prerender-source=1',
      active:true
    });
    const sourceTabId = sourceTab.id;

    // Do not attach a DevTools Protocol session: Chromium disables prerendering
    // when DevTools is attached. The real extension tabs.onReplaced event is
    // the browser-level proof that the prerendered tab replaced the source tab.
    const destination = 'https://example.com/?blb-prerender-destination=1';
    const speculationRulesSupported = await page.evaluate(() =>
      typeof HTMLScriptElement.supports === 'function' &&
      HTMLScriptElement.supports('speculationrules')
    );
    expect(speculationRulesSupported,
      'The selected Chromium build must support the Speculation Rules API'
    ).toBe(true);
    await page.evaluate(url => {
      const script = document.createElement('script');
      script.type = 'speculationrules';
      script.textContent = JSON.stringify({
        prerender:[{source:'list',urls:[url],eagerness:'immediate'}]
      });
      document.head.appendChild(script);
    }, destination);

    // Give the browser time to fetch and prepare the speculative target. We do
    // not use CDP to observe readiness because attaching DevTools suppresses
    // prerendering in Chromium.
    await page.waitForTimeout(2000);
    await page.evaluate(url => { window.location.href = url; }, destination);
    await page.waitForURL(destination, {timeout:15000});
    await page.waitForLoadState('domcontentloaded');

    // Navigation Timing exposes activationStart in the activated document.
    // A normal network navigation reports zero, so this independently proves
    // that the destination was actually prerendered and then activated.
    const activation = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      return {
        activationStart:navigation?.activationStart ?? null,
        prerendering:document.prerendering,
        visibilityState:document.visibilityState,
        userAgent:navigator.userAgent
      };
    });
    console.log('BLB_PRERENDER_ACTIVATION_DIAGNOSTIC ' + JSON.stringify(activation));
    expect(activation.activationStart,
      'Destination must be a prerender-activated document, not a normal navigation: ' +
      JSON.stringify(activation)
    ).toBeGreaterThan(0);

    await expect.poll(() => extensionWorker.evaluate(() =>
      globalThis.__blbPrerenderReplacementEvents || []
    ), {
      timeout:15000,
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
