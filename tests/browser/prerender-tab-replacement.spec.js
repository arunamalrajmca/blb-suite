const { test, expect } = require('./fixtures');
const http = require('node:http');

test('Chromium prerender activation emits a real tabs.onReplaced event and initializes the surviving document', async ({
  context, extensionStorage, extensionWorker
}) => {
  test.setTimeout(90000);
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'127.0.0.1':true},
    doubleClickBlbSites:{'127.0.0.1':true}
  });

  const prerenderRequests = [];
  let destination = '';
  const server = http.createServer((request, response) => {
    if (request.url === '/source') {
      const rules = {
        prerender:[{
          source:'list',
          urls:[destination],
          eagerness:'immediate'
        }]
      };
      response.writeHead(200, {
        'Content-Type':'text/html; charset=utf-8',
        'Cache-Control':'no-store'
      });
      response.end(`<!doctype html>
<html><head><title>BLB prerender source</title>
<script type="speculationrules">${JSON.stringify(rules)}</script>
</head><body>Prerender source page</body></html>`);
      return;
    }
    if (request.url === '/destination') {
      const secPurpose = request.headers['sec-purpose'] || '';
      if (secPurpose.includes('prerender')) {
        prerenderRequests.push({ secPurpose, userAgent:request.headers['user-agent'] || '' });
      }
      response.writeHead(200, {
        'Content-Type':'text/html; charset=utf-8',
        'Cache-Control':'public, max-age=60'
      });
      response.end('<!doctype html><html><head><title>BLB prerender destination</title></head><body>Prerender destination</body></html>');
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  destination = `${origin}/destination`;

  const page = await context.newPage();
  try {
    await page.goto(`${origin}/source`, {waitUntil:'domcontentloaded'});
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
    expect(sourceTab).toMatchObject({ url:`${origin}/source`, active:true });
    const sourceTabId = sourceTab.id;

    const speculationRulesSupported = await page.evaluate(() =>
      typeof HTMLScriptElement.supports === 'function' &&
      HTMLScriptElement.supports('speculationrules')
    );
    expect(speculationRulesSupported,
      'The selected Chromium build must support the Speculation Rules API'
    ).toBe(true);

    // The server-side Sec-Purpose header proves Chromium actually requested
    // the destination as a prerender, without attaching CDP to the source tab.
    await expect.poll(() => prerenderRequests.length, {
      timeout:15000,
      message:'Chromium must request the destination with Sec-Purpose: prefetch;prerender'
    }).toBeGreaterThan(0);

    await page.evaluate(url => { window.location.href = url; }, destination);
    await page.waitForURL(destination, {timeout:15000});
    await page.waitForLoadState('domcontentloaded');

    const activation = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      return {
        activationStart:navigation?.activationStart ?? null,
        prerendering:document.prerendering,
        visibilityState:document.visibilityState,
        userAgent:navigator.userAgent
      };
    });
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
      pageSelectionButtonSites:{'127.0.0.1':false},
      doubleClickBlbSites:{'127.0.0.1':false}
    });
    await extensionWorker.evaluate(() =>
      reconcileRuntimeContentScriptRegistrations().catch(() => {})
    );
    await new Promise(resolve => server.close(resolve));
  }
});
