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
              const values = {};
              for (const key of ['pageSelectionButtonSites','doubleClickBlbSites']) {
                if (key in keys) values[key] = snapshot[key]?.['example.com'] === true;
              }
              return new Promise(resolve => pending.push({
                values,
                resolved:false,
                resolve:() => resolve(snapshot)
              }));
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

  const pendingReadSummary = async () => extensionWorker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => {
        const summary = {
          pageSelectionButtonSites:{on:0,off:0},
          doubleClickBlbSites:{on:0,off:0}
        };
        for (const read of globalThis.__blbFeatureRefreshPendingReads || []) {
          for (const [key, enabled] of Object.entries(read.values)) {
            summary[key][enabled ? 'on' : 'off']++;
          }
        }
        return summary;
      }
    });
    return result.result;
  }, tabId);

  // The page may still have a startup refresh in flight when interception is
  // installed. Do not assume an exact read count: identify each delayed read
  // by its captured settings snapshot and force all newer ON snapshots to
  // resolve before any older OFF snapshots.
  await expect.poll(async () => {
    const summary = await pendingReadSummary();
    return ['pageSelectionButtonSites','doubleClickBlbSites'].every(key =>
      summary[key].on > 0 && summary[key].off > 0
    );
  }).toBe(true);

  await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target:{tabId:id},
    world:'ISOLATED',
    func:() => {
      for (const read of globalThis.__blbFeatureRefreshPendingReads || []) {
        if (!read.resolved && Object.values(read.values).some(enabled => enabled)) {
          read.resolved = true;
          read.resolve();
        }
      }
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
      for (const read of globalThis.__blbFeatureRefreshPendingReads || []) {
        if (!read.resolved && Object.values(read.values).every(enabled => !enabled)) {
          read.resolved = true;
          read.resolve();
        }
      }
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


test('X.com site activation waits for the content-script refresh listener without reloading', async ({
  page, extensionWorker, extensionStorage
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'x.com':false},
    doubleClickBlbSites:{'x.com':false},
    redirectEnabled:false
  });
  await page.route('https://x.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>X activation handshake</title></head><body><p>John 3:16</p></body></html>'
  }));
  await page.goto('https://x.com/', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({url:'https://x.com/*'}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  // Model a content bundle whose runtime listener becomes ready shortly after
  // executeScript completes. The activation handshake must wait for readiness
  // instead of reporting a false failure and requiring a page reload.
  await extensionWorker.evaluate(() => {
    const originalSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
    globalThis.__activationHandshakeOriginals = {originalSendMessage,originalExecuteScript};
    globalThis.__activationHandshakeInjectedAt = 0;
    chrome.tabs.sendMessage = async (...args) => {
      const injectedAt = globalThis.__activationHandshakeInjectedAt;
      if (injectedAt && Date.now() - injectedAt < 180) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return originalSendMessage(...args);
    };
    chrome.scripting.executeScript = async details => {
      const result = await originalExecuteScript(details);
      if (details?.files?.includes('content.js')) globalThis.__activationHandshakeInjectedAt = Date.now();
      return result;
    };
  });

  try {
    await extensionStorage.set({
      pageSelectionButtonSites:{'x.com':true},
      doubleClickBlbSites:{'x.com':true}
    });
    await expect.poll(() => extensionWorker.evaluate(async id => {
      const result = await ensureContentScriptInTab(id);
      const [state] = await chrome.scripting.executeScript({
        target:{tabId:id},
        world:'ISOLATED',
        func:() => ({
          loaded:window.__blbSuiteContentScriptLoadedV2 === true,
          button:!!document.getElementById('blb-suite-page-selection-button'),
          doubleClick:typeof window.__blbSuiteDoubleClickBoundV2 === 'function'
        })
      });
      return {result,...state.result};
    }, tabId), {timeout:15000}).toMatchObject({
      result:true,loaded:true,button:true,doubleClick:true
    });
    expect(await page.evaluate(() => performance.timeOrigin)).toBeTruthy();
  } finally {
    await extensionWorker.evaluate(() => {
      const originals = globalThis.__activationHandshakeOriginals;
      if (originals) {
        chrome.tabs.sendMessage = originals.originalSendMessage;
        chrome.scripting.executeScript = originals.originalExecuteScript;
      }
      delete globalThis.__activationHandshakeOriginals;
      delete globalThis.__activationHandshakeInjectedAt;
    });
  }
});

test('existing www and apex BLB tabs are reactivated after extension update without site toggles', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false
  });
  const body = '<!doctype html><html><head><title>BLB update recovery</title></head><body>John 3:16</body></html>';
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,contentType:'text/html; charset=utf-8',body
  }));
  await page.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', {waitUntil:'domcontentloaded'});
  const secondPage = await context.newPage();
  await secondPage.route('https://blueletterbible.org/**', route => route.fulfill({
    status:200,contentType:'text/html; charset=utf-8',body
  }));
  await secondPage.goto('https://blueletterbible.org/kjv/jhn/3/16/', {waitUntil:'domcontentloaded'});
  try {
    const tabIds = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.filter(tab => /blueletterbible\.org\/kjv\/jhn\/3\/16\//.test(tab.url || ''))
        .map(tab => tab.id);
    });
    expect(tabIds).toHaveLength(2);
    const result = await extensionWorker.evaluate(() => injectConfiguredTabsAfterExtensionUpdate());
    expect(result.eligibleTabIds).toEqual(expect.arrayContaining(tabIds));
    expect(result.activatedTabIds).toEqual(expect.arrayContaining(tabIds));
  } finally {
    await secondPage.close();
  }
});

test('per-site feature changes activate every already-open tab on the matching host', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  }));
  let secondPage;
  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{'example.com':false}
    });
    const fixture = '<!doctype html><html><head><title>Multi-tab site toggle</title></head><body><p>John 3:16</p></body></html>';
    await page.route('https://example.com/**', route => route.fulfill({
      status:200, contentType:'text/html; charset=utf-8', body:fixture
    }));
    await page.goto('https://example.com/site-toggle-first.html', {waitUntil:'domcontentloaded'});
    secondPage = await context.newPage();
    await secondPage.route('https://example.com/**', route => route.fulfill({
      status:200, contentType:'text/html; charset=utf-8', body:fixture
    }));
    await secondPage.goto('https://example.com/site-toggle-second.html', {waitUntil:'domcontentloaded'});
    await secondPage.bringToFront();

    const tabIds = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.filter(tab => /^https:\/\/example\.com\/site-toggle-/.test(tab.url || ''))
        .map(tab => tab.id);
    });
    expect(tabIds).toHaveLength(2);

    // Both pages were opened while the site features were OFF, and neither
    // should have a resident content script yet.
    for (const tabId of tabIds) {
      await expect.poll(() => isolatedTabState(extensionWorker, tabId)).toEqual({
        floatingButtonPresent:false,
        doubleClickEnabled:false
      });
    }

    await extensionStorage.set({
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{'example.com':true}
    });
    for (const tabId of tabIds) {
      await expect.poll(() => isolatedTabState(extensionWorker, tabId), {timeout:15000}).toEqual({
        floatingButtonPresent:true,
        doubleClickEnabled:true
      });
    }

    // Disabling the preferences must also reach both resident content-script
    // instances without requiring either document to navigate or gain focus.
    await extensionStorage.set({
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{'example.com':false}
    });
    for (const tabId of tabIds) {
      await expect.poll(() => isolatedTabState(extensionWorker, tabId)).toEqual({
        floatingButtonPresent:false,
        doubleClickEnabled:false
      });
    }
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
    await secondPage?.close().catch(() => {});
  }
});




test('host permission revocation disables both site features in every open tab until access is restored', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false,
    siteHostAccessRevokedSites:{}
  }));
  let secondPage;
  try {
    const cleanRevokedSites = {...(previous.siteHostAccessRevokedSites || {})};
    delete cleanRevokedSites[pattern];
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{'example.com':false},
      redirectEnabled:false,
      siteHostAccessRevokedSites:cleanRevokedSites
    });
    await extensionWorker.evaluate(async originPattern =>
      unregisterRuntimeContentScriptForPattern(originPattern), pattern
    );
    await expect.poll(() => extensionWorker.evaluate(async originPattern =>
      (await chrome.scripting.getRegisteredContentScripts({
        ids:[runtimeContentScriptIdForPattern(originPattern)]
      })).length
    , pattern)).toBe(0);

    const fixture = '<!doctype html><html><head><title>Permission revoke</title></head><body><p>John 3:16</p></body></html>';
    await page.route('https://example.com/**', route => route.fulfill({
      status:200, contentType:'text/html; charset=utf-8', body:fixture
    }));
    await page.goto('https://example.com/permission-revoke-first.html', {waitUntil:'domcontentloaded'});
    secondPage = await context.newPage();
    await secondPage.route('https://example.com/**', route => route.fulfill({
      status:200, contentType:'text/html; charset=utf-8', body:fixture
    }));
    await secondPage.goto('https://example.com/permission-revoke-second.html', {waitUntil:'domcontentloaded'});

    const tabIds = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.filter(tab => /^https:\/\/example\.com\/permission-revoke-/.test(tab.url || ''))
        .map(tab => tab.id);
    });
    expect(tabIds).toHaveLength(2);
    for (const tabId of tabIds) {
      await expect.poll(() => isolatedTabState(extensionWorker, tabId)).toEqual({
        floatingButtonPresent:false,
        doubleClickEnabled:false
      });
    }

    await extensionStorage.set({
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{'example.com':true}
    });
    for (const tabId of tabIds) {
      const injected = await extensionWorker.evaluate(id => ensureContentScriptInTab(id), tabId);
      expect(injected).toBe(true);
      await expect.poll(() => isolatedTabState(extensionWorker, tabId), {timeout:15000}).toEqual({
        floatingButtonPresent:true,
        doubleClickEnabled:true
      });
    }

    await extensionWorker.evaluate(async originPattern => {
      const originalContains = chrome.permissions.contains;
      chrome.permissions.contains = async details =>
        details?.origins?.includes(originPattern) ? false : originalContains(details);
      try {
        await handleHostPermissionsRemoved([originPattern]);
        // Changes to either site preference while access is revoked must not
        // reactivate controls in an already-running document.
        await chrome.storage.local.set({
          pageSelectionButtonSites:{'example.com':false},
          doubleClickBlbSites:{'example.com':false}
        });
        await chrome.storage.local.set({
          pageSelectionButtonSites:{'example.com':true},
          doubleClickBlbSites:{'example.com':true}
        });
      } finally {
        chrome.permissions.contains = originalContains;
      }
    }, pattern);

    const disabled = {floatingButtonPresent:false,doubleClickEnabled:false};
    for (const tabId of tabIds) {
      await expect.poll(() => isolatedTabState(extensionWorker, tabId), {timeout:15000}).toEqual(disabled);
    }
    const revokedState = await extensionWorker.evaluate(() => chrome.storage.local.get({
      siteHostAccessRevokedSites:{},
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{}
    }));
    expect(revokedState.siteHostAccessRevokedSites[pattern]).toBe(true);
    expect(revokedState.pageSelectionButtonSites['example.com']).toBe(true);
    expect(revokedState.doubleClickBlbSites['example.com']).toBe(true);

    await extensionWorker.evaluate(originPattern =>
      handleGrantedHostPermissions([originPattern]), pattern
    );
    for (const tabId of tabIds) {
      await expect.poll(() => isolatedTabState(extensionWorker, tabId), {timeout:15000}).toEqual({
        floatingButtonPresent:true,
        doubleClickEnabled:true
      });
    }
    const restoredState = await extensionWorker.evaluate(() => chrome.storage.local.get({
      siteHostAccessRevokedSites:{}
    }));
    expect(restoredState.siteHostAccessRevokedSites[pattern]).toBeUndefined();
  } finally {
    await extensionWorker.evaluate(async ({originPattern,settings}) => {
      await unregisterRuntimeContentScriptForPattern(originPattern);
      await chrome.storage.local.set(settings);
    }, {originPattern:pattern,settings:previous});
    await secondPage?.close().catch(() => {});
  }
});


test('content-script reinjection replaces the page-selection runtime message listener', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: {}
  });
  await page.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Page button reinjection</title></head><body><p>John 3:16</p></body></html>'
  }));
  await page.goto('https://example.com/page-button-reinjection.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#blb-suite-page-selection-button')).toHaveCount(1);

  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ url: 'https://example.com/page-button-reinjection.html' }))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  const initial = await extensionWorker.evaluate(async id => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      func: () => {
        const event = chrome.runtime.onMessage;
        const originalAdd = event.addListener.bind(event);
        const originalRemove = event.removeListener.bind(event);
        const handlers = new Set();
        Object.defineProperty(event, 'addListener', {
          configurable: true,
          value: listener => {
            if (listener?.name === 'pageButtonRuntimeMessageHandler') handlers.add(listener);
            return originalAdd(listener);
          }
        });
        Object.defineProperty(event, 'removeListener', {
          configurable: true,
          value: listener => {
            if (listener?.name === 'pageButtonRuntimeMessageHandler') handlers.delete(listener);
            return originalRemove(listener);
          }
        });
        globalThis.__pageButtonRuntimeListenerAudit = { handlers, originalAdd, originalRemove };
        return handlers.size;
      }
    });
    return injected.result;
  }, tabId);
  expect(initial).toBe(0);

  for (let pass = 0; pass < 2; pass++) {
    await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'ISOLATED',
      files: ['content.js']
    }), tabId);
    await expect.poll(() => extensionWorker.evaluate(async id => {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: id },
        world: 'ISOLATED',
        func: () => globalThis.__pageButtonRuntimeListenerAudit?.handlers.size ?? -1
      });
      return injected.result;
    }, tabId), { timeout: 10000 }).toBe(1);
  }

  await extensionWorker.evaluate(async id => chrome.scripting.executeScript({
    target: { tabId: id },
    world: 'ISOLATED',
    func: () => {
      const audit = globalThis.__pageButtonRuntimeListenerAudit;
      if (!audit) return;
      Object.defineProperty(chrome.runtime.onMessage, 'addListener', {
        configurable: true, value: audit.originalAdd
      });
      Object.defineProperty(chrome.runtime.onMessage, 'removeListener', {
        configurable: true, value: audit.originalRemove
      });
      delete globalThis.__pageButtonRuntimeListenerAudit;
    }
  }), tabId);
});
