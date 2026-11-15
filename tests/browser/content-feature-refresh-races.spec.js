const { test, expect } = require('./fixtures');

async function isolatedTabState(extensionWorker, tabId) {
  const [result] = await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target:{tabId:id},
    world:'ISOLATED',
    func:() => ({
      floatingButtonPresent:Boolean(document.getElementById('blb-suite-page-selection-button')),
      doubleClickEnabled:typeof window.__blbSuiteDoubleClickBoundV2 === 'function'
    })
  }), tabId);
  return result.result;
}

test('latest per-site selection settings win when content-script storage reads resolve out of order', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{'example.com':true}
  });
  await page.route('https://www.example.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>Selection feature race</title></head><body><p>John 3:16</p></body></html>'
  }));
  await page.goto('https://www.example.com/selection-feature-race.html', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({url:'https://www.example.com/selection-feature-race.html'}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  await expect.poll(() => isolatedTabState(extensionWorker, tabId)).toEqual({
    floatingButtonPresent:true,
    doubleClickEnabled:true
  });

  const interception = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => {
        const local = chrome.storage.local;
        const originalGet = local.get.bind(local);
        const pending = [];
        Object.defineProperty(local, 'get', {
          configurable:true,
          value:async (...args) => {
            const snapshot = await originalGet(...args);
            const keys = args[0];
            if (keys && typeof keys === 'object' &&
                ('pageSelectionButtonSites' in keys || 'doubleClickBlbSites' in keys)) {
              return new Promise(resolve => pending.push(() => resolve(snapshot)));
            }
            return snapshot;
          }
        });
        globalThis.__blbFeatureRefreshPendingReads = pending;
        return {installed:true};
      }
    });
    return injected.result;
  }, tabId);
  expect(interception.installed).toBe(true);

  // Queue older OFF reads first, then newer ON reads. Resolve ON before OFF
  // to prove an obsolete storage response cannot undo the latest preference.
  await extensionWorker.evaluate(() => chrome.storage.local.set({
    pageSelectionButtonSites:{'example.com':false},
    doubleClickBlbSites:{'example.com':false}
  }));
  await extensionWorker.evaluate(() => chrome.storage.local.set({
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{'example.com':true}
  }));

  await expect.poll(() => extensionWorker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => globalThis.__blbFeatureRefreshPendingReads?.length || 0
    });
    return result.result;
  }, tabId)).toBe(4);

  await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target:{tabId:id},
    world:'ISOLATED',
    func:() => {
      const pending = globalThis.__blbFeatureRefreshPendingReads;
      pending[2]();
      pending[3]();
    }
  }), tabId);
  await expect.poll(() => isolatedTabState(extensionWorker, tabId)).toEqual({
    floatingButtonPresent:true,
    doubleClickEnabled:true
  });

  await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target:{tabId:id},
    world:'ISOLATED',
    func:() => {
      const pending = globalThis.__blbFeatureRefreshPendingReads;
      pending[0]();
      pending[1]();
    }
  }), tabId);
  await expect.poll(() => isolatedTabState(extensionWorker, tabId)).toEqual({
    floatingButtonPresent:true,
    doubleClickEnabled:true
  });
});

test('source-page collector does not add its button after a pending initialization observes global OFF', async ({
  page, extensionWorker
}) => {
  await page.route('https://www.dailyverses.net/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>Daily verse article</title></head><body><main>John 3:16</main></body></html>'
  }));
  await page.goto('https://www.dailyverses.net/fixture-article.html', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({url:'https://www.dailyverses.net/fixture-article.html'}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);
  await expect(page.locator('#blb-suite-dailyverses-multiverse')).toBeVisible();

  const result = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:async () => {
        document.getElementById('blb-suite-dailyverses-multiverse')?.remove();
        let enabled = true;
        let resolveRead;
        const delayedRead = new Promise(resolve => { resolveRead = resolve; });
        globalThis.BLBSourcePageCollectorModule.initialize({
          normalizeSelectionText:value => String(value || '').trim(),
          parseRef:() => null,
          normalizeSourceBibleBook:value => value,
          resolveBibleReference:() => null,
          blbUrl:() => null,
          formatSourceBibleBookName:value => value,
          isSuiteEnabled:() => delayedRead,
          isSuiteEnabledNow:() => enabled,
          makeBlbMultiVerseButtonDraggable:() => {}
        });
        enabled = false;
        resolveRead(true);
        await Promise.resolve();
        await Promise.resolve();
        return Boolean(document.getElementById('blb-suite-dailyverses-multiverse'));
      }
    });
    return injected.result;
  }, tabId);
  expect(result).toBe(false);
});
