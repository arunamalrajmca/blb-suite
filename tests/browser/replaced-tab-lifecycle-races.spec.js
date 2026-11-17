const { test, expect } = require('./fixtures');

async function installReplacementActivationGate(extensionWorker, tabId) {
  await extensionWorker.evaluate(id => {
    const original = ensureContentScriptInTab;
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    globalThis.__replacementActivationGate = {
      started,
      release:() => release(),
      restore:() => { ensureContentScriptInTab = original; }
    };
    ensureContentScriptInTab = async currentTabId => {
      if (currentTabId !== id) return original(currentTabId);
      entered();
      await gate;
      const result = await original(currentTabId);
      globalThis.__replacementActivationResult = result;
      return result;
    };
  }, tabId);
}

async function cleanupReplacementActivationGate(extensionWorker, extensionStorage, page) {
  await extensionWorker.evaluate(() => {
    globalThis.__replacementActivationGate?.release();
    globalThis.__replacementActivationGate?.restore();
    if (globalThis.__replacementHostAccessCheck) {
      hasHostAccessForTab = globalThis.__replacementHostAccessCheck;
      delete globalThis.__replacementHostAccessCheck;
    }
    delete globalThis.__replacementActivationGate;
    delete globalThis.__replacementActivationResult;
  }).catch(() => {});
  await page?.close().catch(() => {});
  await extensionStorage.set({
    pageSelectionButtonSites:{'example.com':false},
    doubleClickBlbSites:{}
  });
  await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations().catch(() => {}));
}

test('replacement recovery rechecks the latest site preference before injecting', async ({
  context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  try {
    await page.goto('https://example.com/?replacement-preference-race=1', {waitUntil:'domcontentloaded'});
    const tabId = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return tabs[0]?.id;
    });
    expect(tabId).toBeTruthy();

    await installReplacementActivationGate(extensionWorker, tabId);
    await extensionWorker.evaluate(id => { globalThis.__replacementRecoveryPromise = handleReplacedTabIdentity(id, 940011); return true; }, tabId);
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.started);

    // The replacement passed its initial eligibility check, but the user turns
    // the feature OFF before the actual tab activation begins.
    await extensionStorage.set({pageSelectionButtonSites:{'example.com':false}});
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.release());
    await extensionWorker.evaluate(async () => { await globalThis.__replacementRecoveryPromise; delete globalThis.__replacementRecoveryPromise; });

    expect(await extensionWorker.evaluate(() => globalThis.__replacementActivationResult)).toBe(false);
  } finally {
    await cleanupReplacementActivationGate(extensionWorker, extensionStorage, page);
  }
});

test('replacement recovery does not inject when the replacement tab closes during activation', async ({
  context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  try {
    await page.goto('https://example.com/?replacement-close-race=1', {waitUntil:'domcontentloaded'});
    const tabId = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return tabs[0]?.id;
    });
    expect(tabId).toBeTruthy();

    await installReplacementActivationGate(extensionWorker, tabId);
    await extensionWorker.evaluate(id => { globalThis.__replacementRecoveryPromise = handleReplacedTabIdentity(id, 940012); return true; }, tabId);
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.started);

    await page.close();
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.release());
    await extensionWorker.evaluate(async () => { await globalThis.__replacementRecoveryPromise; delete globalThis.__replacementRecoveryPromise; });

    expect(await extensionWorker.evaluate(() => globalThis.__replacementActivationResult)).toBe(false);
  } finally {
    await cleanupReplacementActivationGate(extensionWorker, extensionStorage, page);
  }
});


test('replacement recovery does not inject after host permission is revoked during activation', async ({
  context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  try {
    await page.goto('https://example.com/?replacement-permission-race=1', {waitUntil:'domcontentloaded'});
    const tabId = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return tabs[0]?.id;
    });
    expect(tabId).toBeTruthy();
    // Let any navigation-triggered activation finish so this test controls the
    // only in-flight activation for the replacement tab.
    await extensionWorker.evaluate(async id => {
      const pending = contentScriptInjectionLocks.get(id);
      if (pending) await pending.catch(() => {});
    }, tabId);

    await installReplacementActivationGate(extensionWorker, tabId);
    await extensionWorker.evaluate(id => { globalThis.__replacementRecoveryPromise = handleReplacedTabIdentity(id, 940013); return true; }, tabId);
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.started);

    // Simulate permission revocation after replacement eligibility passed but
    // before ensureContentScriptInTab performs its own authoritative recheck.
    await extensionWorker.evaluate(id => {
      globalThis.__replacementHostAccessCheck = hasHostAccessForTab;
      const original = globalThis.__replacementHostAccessCheck;
      hasHostAccessForTab = async tab => tab?.id === id ? false : original(tab);
      globalThis.__replacementActivationGate.release();
    }, tabId);
    await extensionWorker.evaluate(async () => { await globalThis.__replacementRecoveryPromise; delete globalThis.__replacementRecoveryPromise; });

    expect(await extensionWorker.evaluate(() => globalThis.__replacementActivationResult)).toBe(false);
  } finally {
    await cleanupReplacementActivationGate(extensionWorker, extensionStorage, page);
  }
});


test('overlapping chained replacements migrate tab-owned state to the final tab', async ({
  extensionWorker
}) => {
  const ids = {a:940101, b:940102, c:940103};
  const logicalKey = 'replacement-chain-test|logical';
  const scriptKey = 'replacement-chain-test|script';
  try {
    await extensionWorker.evaluate(async ({a,b}) => {
      await updateTrackedMultiVerseTabs(map => { map[String(a)] = {marker:'chain-tracked'}; });
      await updatePendingMultiVerseRefsByTab(map => {
        map[String(a)] = [{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}];
      });
      blbLogicalTabRegistry.set('replacement-chain-test|logical', a);
      intentionalNewBlbTabs.add(a);
      scriptTaggerDestinationTabs.set('replacement-chain-test|script', a);
    }, ids);

    // Both events begin before either asynchronous storage migration finishes:
    // A→B followed immediately by B→C must leave every owner at C.
    await Promise.all([
      extensionWorker.evaluate(({a,b}) => handleReplacedTabIdentity(b,a), ids),
      extensionWorker.evaluate(({b,c}) => handleReplacedTabIdentity(c,b), ids)
    ]);

    const result = await extensionWorker.evaluate(async ({a,b,c}) => {
      const tracked = await getTrackedMultiVerseTabs();
      const pending = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
      return {
        logical:blbLogicalTabRegistry.get('replacement-chain-test|logical'),
        intentionalA:intentionalNewBlbTabs.has(a),
        intentionalB:intentionalNewBlbTabs.has(b),
        intentionalC:intentionalNewBlbTabs.has(c),
        script:scriptTaggerDestinationTabs.get('replacement-chain-test|script'),
        trackedA:tracked[String(a)],
        trackedB:tracked[String(b)],
        trackedC:tracked[String(c)],
        pendingA:pending.blbSuitePendingMultiVerseRefsByTab[String(a)],
        pendingB:pending.blbSuitePendingMultiVerseRefsByTab[String(b)],
        pendingC:pending.blbSuitePendingMultiVerseRefsByTab[String(c)]
      };
    }, ids);

    expect(result).toMatchObject({
      logical:ids.c,
      intentionalA:false,
      intentionalB:false,
      intentionalC:true,
      script:ids.c,
      trackedC:{marker:'chain-tracked'},
      pendingC:[{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}]
    });
    expect(result.trackedA).toBeUndefined();
    expect(result.trackedB).toBeUndefined();
    expect(result.pendingA).toBeUndefined();
    expect(result.pendingB).toBeUndefined();
  } finally {
    await extensionWorker.evaluate(async ({a,b,c}) => {
      blbLogicalTabRegistry.delete('replacement-chain-test|logical');
      scriptTaggerDestinationTabs.delete('replacement-chain-test|script');
      intentionalNewBlbTabs.delete(a);
      intentionalNewBlbTabs.delete(b);
      intentionalNewBlbTabs.delete(c);
      await updateTrackedMultiVerseTabs(map => {
        delete map[String(a)]; delete map[String(b)]; delete map[String(c)];
      });
      await updatePendingMultiVerseRefsByTab(map => {
        delete map[String(a)]; delete map[String(b)]; delete map[String(c)];
      });
    }, ids);
  }
});

test('duplicate overlapping replacement events share one content-script activation', async ({
  context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  try {
    await page.goto('https://example.com/?duplicate-replacement-event=1', {waitUntil:'domcontentloaded'});
    const tabId = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return tabs.find(tab => String(tab.url || '').includes('duplicate-replacement-event'))?.id;
    });
    expect(tabId).toBeTruthy();
    await extensionWorker.evaluate(async id => {
      const pending = contentScriptInjectionLocks.get(id);
      if (pending) await pending.catch(() => {});
    }, tabId);

    await extensionWorker.evaluate(() => {
      const original = chrome.tabs.sendMessage;
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      globalThis.__duplicateReplacementSendMessage = {
        original, started, release:() => release(), calls:0,
        restore:() => { chrome.tabs.sendMessage = original; }
      };
      chrome.tabs.sendMessage = async (...args) => {
        globalThis.__duplicateReplacementSendMessage.calls++;
        if (globalThis.__duplicateReplacementSendMessage.calls === 1) {
          entered();
          await gate;
        }
        return original.apply(chrome.tabs, args);
      };
    });

    const first = extensionWorker.evaluate(id => handleReplacedTabIdentity(id, 940111), tabId);
    const second = extensionWorker.evaluate(id => handleReplacedTabIdentity(id, 940112), tabId);
    await extensionWorker.evaluate(() => globalThis.__duplicateReplacementSendMessage.started);
    await extensionWorker.evaluate(() => globalThis.__duplicateReplacementSendMessage.release());
    await Promise.all([first, second]);

    const calls = await extensionWorker.evaluate(() => {
      const calls = globalThis.__duplicateReplacementSendMessage.calls;
      globalThis.__duplicateReplacementSendMessage.restore();
      delete globalThis.__duplicateReplacementSendMessage;
      return calls;
    });
    expect(calls).toBe(1);
  } finally {
    await extensionWorker.evaluate(() => {
      globalThis.__duplicateReplacementSendMessage?.restore();
      delete globalThis.__duplicateReplacementSendMessage;
    }).catch(() => {});
    await page.close().catch(() => {});
    await extensionStorage.set({pageSelectionButtonSites:{'example.com':false}});
    await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations().catch(() => {}));
  }
});
