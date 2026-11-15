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
  await page.route('https://example.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>Selection feature race</title></head><body><p>John 3:16</p></body></html>'
  }));
  await page.goto('https://example.com/selection-feature-race.html', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({url:'https://example.com/selection-feature-race.html'}))[0]?.id
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


test('repeated per-site feature toggles do not accumulate page-selection or double-click listeners', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{'example.com':true}
  });
  await page.route('https://example.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>Repeated feature toggles</title></head><body><p>John 3:16</p></body></html>'
  }));
  await page.goto('https://example.com/repeated-feature-toggles.html', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({url:'https://example.com/repeated-feature-toggles.html'}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);
  const button = page.locator('#blb-suite-page-selection-button');
  await expect(button).toHaveCount(1);

  const instrumented = await extensionWorker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => {
        const types = ['mousedown','keydown','mouseup','keyup','dblclick'];
        const active = Object.fromEntries(types.map(type => [type, new Set()]));
        const pageHandlers = window.__blbSuitePageButtonHandlersV2 || {};
        for (const [type, handler] of Object.entries(pageHandlers)) {
          if (active[type] && typeof handler === 'function') active[type].add(handler);
        }
        const doubleClickHandler = window.__blbSuiteDoubleClickBoundV2;
        if (typeof doubleClickHandler === 'function') active.dblclick.add(doubleClickHandler);
        const originalAdd = document.addEventListener;
        const originalRemove = document.removeEventListener;
        document.addEventListener = function(type, handler, options) {
          if (active[type] && typeof handler === 'function') active[type].add(handler);
          return originalAdd.call(this, type, handler, options);
        };
        document.removeEventListener = function(type, handler, options) {
          if (active[type] && typeof handler === 'function') active[type].delete(handler);
          return originalRemove.call(this, type, handler, options);
        };
        globalThis.__blbToggleListenerAudit = {active, originalAdd, originalRemove};
        return Object.fromEntries(types.map(type => [type, active[type].size]));
      }
    });
    return result.result;
  }, tabId);
  expect(instrumented).toEqual({
    mousedown:1, keydown:1, mouseup:1, keyup:1, dblclick:1
  });

  const readActiveListeners = () => extensionWorker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => Object.fromEntries(
        Object.entries(globalThis.__blbToggleListenerAudit.active).map(([type, handlers]) => [type, handlers.size])
      )
    });
    return result.result;
  }, tabId);

  for (let cycle = 0; cycle < 4; cycle++) {
    await extensionStorage.set({
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{'example.com':false}
    });
    await expect(button).toHaveCount(0);
    await expect.poll(readActiveListeners).toEqual({
      mousedown:0, keydown:0, mouseup:0, keyup:0, dblclick:0
    });

    await extensionStorage.set({
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{'example.com':true}
    });
    await expect(button).toHaveCount(1);
    await expect.poll(readActiveListeners).toEqual({
      mousedown:1, keydown:1, mouseup:1, keyup:1, dblclick:1
    });
  }

  await extensionWorker.evaluate(async id => {
    await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => {
        const audit = globalThis.__blbToggleListenerAudit;
        if (!audit) return;
        document.addEventListener = audit.originalAdd;
        document.removeEventListener = audit.originalRemove;
        delete globalThis.__blbToggleListenerAudit;
      }
    });
  }, tabId);
});

test('repeated global master toggles recreate exactly one collector control across supported collector sites', async ({
  page, extensionStorage
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });

  const fixtures = [
    {
      url:'https://www.dailyverses.net/fixture-global-toggle.html',
      route:'https://www.dailyverses.net/**',
      button:'#blb-suite-dailyverses-multiverse',
      reset:'#blb-suite-dailyverses-multiverse-reset-position',
      body:'<!doctype html><html><head><title>Daily verses toggle</title></head><body><main>John 3:16</main></body></html>'
    },
    {
      url:'https://www.thekingsbible.com/dictionary/faith',
      route:'https://www.thekingsbible.com/**',
      button:'#blb-suite-kingsbible-multiverse',
      reset:'#blb-suite-kingsbible-multiverse-reset-position',
      body:'<!doctype html><html><head><title>King James Bible dictionary</title></head><body><main><a class="bible" data-bible="43003016">John 3:16</a></main></body></html>'
    },
    {
      url:'https://webstersdictionary1828.com/dictionary/faith',
      route:'https://webstersdictionary1828.com/**',
      button:'#blb-suite-webster-multiverse',
      reset:'#blb-suite-webster-multiverse-reset-position',
      body:'<!doctype html><html><head><title>Webster dictionary</title></head><body><main><a class="bible" href="/Bible/43/3">John 3:16</a></main></body></html>'
    }
  ];

  for (const fixture of fixtures) {
    await page.route(fixture.route, route => route.fulfill({
      status:200,
      contentType:'text/html; charset=utf-8',
      body:fixture.body
    }));
    await page.goto(fixture.url, {waitUntil:'domcontentloaded'});
    const button = page.locator(fixture.button);
    await expect(button).toHaveCount(1, {timeout:10000});
    await expect(button).toBeVisible();

    for (let cycle = 0; cycle < 4; cycle++) {
      await extensionStorage.set({masterEnabled:false});
      await expect(button).toHaveCount(0);
      await expect(page.locator(fixture.reset)).toHaveCount(0);

      await extensionStorage.set({masterEnabled:true});
      await expect(button).toHaveCount(1, {timeout:10000});
      await expect(button).toBeVisible();
      await expect(page.locator(fixture.reset)).toHaveCount(1);

      // Replacing the body must recover one control, not preserve a detached
      // control or create a second one through accumulated observers.
      await page.evaluate(() => document.body.replaceWith(document.createElement('body')));
      await expect(button).toHaveCount(1, {timeout:10000});
      await expect(page.locator(fixture.reset)).toHaveCount(1);
    }
  }
});



test('repeated global master toggles disable and restore exactly one double-click listener', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{'example.com':true}
  });
  await page.route('https://example.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>Master double-click toggle</title></head><body><p>John 3:16</p></body></html>'
  }));
  await page.goto('https://example.com/master-double-click-toggle.html', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({url:'https://example.com/master-double-click-toggle.html'}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  const instrumented = await extensionWorker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => {
        const active = new Set();
        const handler = window.__blbSuiteDoubleClickBoundV2;
        if (typeof handler === 'function') active.add(handler);
        const originalAdd = document.addEventListener;
        const originalRemove = document.removeEventListener;
        document.addEventListener = function(type, listener, options) {
          if (type === 'dblclick' && typeof listener === 'function') active.add(listener);
          return originalAdd.call(this, type, listener, options);
        };
        document.removeEventListener = function(type, listener, options) {
          if (type === 'dblclick' && typeof listener === 'function') active.delete(listener);
          return originalRemove.call(this, type, listener, options);
        };
        globalThis.__blbMasterDoubleClickAudit = {active, originalAdd, originalRemove};
        return active.size;
      }
    });
    return result.result;
  }, tabId);
  expect(instrumented).toBe(1);

  const readListenerCount = () => extensionWorker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => globalThis.__blbMasterDoubleClickAudit?.active.size ?? -1
    });
    return result.result;
  }, tabId);

  for (let cycle = 0; cycle < 4; cycle++) {
    await extensionStorage.set({masterEnabled:false});
    await expect.poll(readListenerCount).toBe(0);
    await extensionStorage.set({masterEnabled:true});
    await expect.poll(readListenerCount).toBe(1);
  }

  await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target:{tabId:id},
    world:'ISOLATED',
    func:() => {
      const audit = globalThis.__blbMasterDoubleClickAudit;
      if (!audit) return;
      document.addEventListener = audit.originalAdd;
      document.removeEventListener = audit.originalRemove;
      delete globalThis.__blbMasterDoubleClickAudit;
    }
  }), tabId);
});
