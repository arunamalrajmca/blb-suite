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
    // These IDs model tabs in a deterministic migration-only test. Keep B and
    // C logically live so the production liveness guard does not treat the
    // synthetic identities as genuinely closed browser tabs.
    await extensionWorker.evaluate(({b,c}) => {
      globalThis.__replacementSyntheticGetLiveTabById = getLiveTabById;
      getLiveTabById = async id => [b,c].includes(id)
        ? {id,url:'https://example.com/'} : globalThis.__replacementSyntheticGetLiveTabById(id);
    }, ids);
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
      if (globalThis.__replacementSyntheticGetLiveTabById) {
        getLiveTabById = globalThis.__replacementSyntheticGetLiveTabById;
        delete globalThis.__replacementSyntheticGetLiveTabById;
      }
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


test('replacement tab closing during state migration clears migrated tab-owned state', async ({
  context, extensionWorker
}) => {
  const removedTabId = 940201;
  const logicalKey = 'replacement-close-migration|logical';
  const scriptKey = 'replacement-close-migration|script';
  const page = await context.newPage();
  try {
    await page.goto('https://example.com/?replacement-close-during-migration=1', {waitUntil:'domcontentloaded'});
    const addedTabId = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return tabs.find(tab => String(tab.url || '').includes('replacement-close-during-migration'))?.id;
    });
    expect(addedTabId).toBeTruthy();

    await extensionWorker.evaluate(async ({removedTabId,logicalKey,scriptKey}) => {
      await updateTrackedMultiVerseTabs(map => {
        map[String(removedTabId)] = {marker:'closing-during-migration'};
      });
      await updatePendingMultiVerseRefsByTab(map => {
        map[String(removedTabId)] = [{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}];
      });
      blbLogicalTabRegistry.set(logicalKey, removedTabId);
      intentionalNewBlbTabs.add(removedTabId);
      scriptTaggerDestinationTabs.set(scriptKey, removedTabId);
    }, {removedTabId,logicalKey,scriptKey});

    await extensionWorker.evaluate(({removedTabId}) => {
      const original = updateTrackedMultiVerseTabs;
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      globalThis.__replacementMigrationGate = {
        started,
        release:() => release(),
        restore:() => { updateTrackedMultiVerseTabs = original; }
      };
      updateTrackedMultiVerseTabs = mutator => original(async map => {
        if (!globalThis.__replacementMigrationGate.entered && map[String(removedTabId)]) {
          globalThis.__replacementMigrationGate.entered = true;
          entered();
          await gate;
        }
        return mutator(map);
      });
    }, {removedTabId});

    await extensionWorker.evaluate(({addedTabId,removedTabId}) => {
      globalThis.__replacementMigrationPromise = handleReplacedTabIdentity(addedTabId, removedTabId);
    }, {addedTabId,removedTabId});
    await extensionWorker.evaluate(() => globalThis.__replacementMigrationGate.started);

    // onRemoved cleanup runs while the tracked-state migration is blocked.
    // The pending-reference cleanup can therefore complete before the later
    // migration queue moves the old record onto this now-closed destination.
    await page.close();
    await extensionWorker.evaluate(() => globalThis.__replacementMigrationGate.release());
    await extensionWorker.evaluate(async () => {
      await globalThis.__replacementMigrationPromise;
      await pendingMultiVerseTrackingUpdate;
      await pendingMultiVerseRefsUpdate;
      delete globalThis.__replacementMigrationPromise;
    });

    const result = await extensionWorker.evaluate(async ({addedTabId,removedTabId,logicalKey,scriptKey}) => {
      const tracked = await getTrackedMultiVerseTabs();
      const pending = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
      return {
        logical:blbLogicalTabRegistry.get(logicalKey),
        intentionalAdded:intentionalNewBlbTabs.has(addedTabId),
        intentionalRemoved:intentionalNewBlbTabs.has(removedTabId),
        script:scriptTaggerDestinationTabs.get(scriptKey),
        trackedAdded:tracked[String(addedTabId)],
        trackedRemoved:tracked[String(removedTabId)],
        pendingAdded:pending.blbSuitePendingMultiVerseRefsByTab[String(addedTabId)],
        pendingRemoved:pending.blbSuitePendingMultiVerseRefsByTab[String(removedTabId)]
      };
    }, {addedTabId,removedTabId,logicalKey,scriptKey});
    expect(result).toEqual({
      logical:undefined,
      intentionalAdded:false,
      intentionalRemoved:false,
      script:undefined,
      trackedAdded:undefined,
      trackedRemoved:undefined,
      pendingAdded:undefined,
      pendingRemoved:undefined
    });
  } finally {
    await extensionWorker.evaluate(() => {
      globalThis.__replacementMigrationGate?.release();
      globalThis.__replacementMigrationGate?.restore();
      delete globalThis.__replacementMigrationGate;
      delete globalThis.__replacementMigrationPromise;
    }).catch(() => {});
    await page.close().catch(() => {});
    await extensionWorker.evaluate(async ({removedTabId,logicalKey,scriptKey}) => {
      blbLogicalTabRegistry.delete(logicalKey);
      scriptTaggerDestinationTabs.delete(scriptKey);
      intentionalNewBlbTabs.delete(removedTabId);
      await updateTrackedMultiVerseTabs(map => { delete map[String(removedTabId)]; });
      await updatePendingMultiVerseRefsByTab(map => { delete map[String(removedTabId)]; });
    }, {removedTabId,logicalKey,scriptKey}).catch(() => {});
  }
});

test('replacement tab closing during activation leaves no migrated tab-owned state', async ({
  context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  const logicalKey = 'replacement-close-activation|logical';
  const scriptKey = 'replacement-close-activation|script';
  try {
    await page.goto('https://example.com/?replacement-close-during-activation=1', {waitUntil:'domcontentloaded'});
    const addedTabId = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return tabs.find(tab => String(tab.url || '').includes('replacement-close-during-activation'))?.id;
    });
    expect(addedTabId).toBeTruthy();
    const removedTabId = 940202;
    await extensionWorker.evaluate(async ({removedTabId,logicalKey,scriptKey}) => {
      await updateTrackedMultiVerseTabs(map => { map[String(removedTabId)] = {marker:'closing-during-activation'}; });
      await updatePendingMultiVerseRefsByTab(map => {
        map[String(removedTabId)] = [{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}];
      });
      blbLogicalTabRegistry.set(logicalKey, removedTabId);
      intentionalNewBlbTabs.add(removedTabId);
      scriptTaggerDestinationTabs.set(scriptKey, removedTabId);
    }, {removedTabId,logicalKey,scriptKey});

    await installReplacementActivationGate(extensionWorker, addedTabId);
    await extensionWorker.evaluate(({addedTabId,removedTabId}) => {
      globalThis.__replacementRecoveryPromise = handleReplacedTabIdentity(addedTabId, removedTabId);
    }, {addedTabId,removedTabId});
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.started);

    await page.close();
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.release());
    await extensionWorker.evaluate(async () => {
      await globalThis.__replacementRecoveryPromise;
      await pendingMultiVerseTrackingUpdate;
      await pendingMultiVerseRefsUpdate;
      delete globalThis.__replacementRecoveryPromise;
    });

    const result = await extensionWorker.evaluate(async ({addedTabId,removedTabId,logicalKey,scriptKey}) => {
      const tracked = await getTrackedMultiVerseTabs();
      const pending = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
      return {
        logical:blbLogicalTabRegistry.get(logicalKey),
        intentionalAdded:intentionalNewBlbTabs.has(addedTabId),
        intentionalRemoved:intentionalNewBlbTabs.has(removedTabId),
        script:scriptTaggerDestinationTabs.get(scriptKey),
        trackedAdded:tracked[String(addedTabId)],
        trackedRemoved:tracked[String(removedTabId)],
        pendingAdded:pending.blbSuitePendingMultiVerseRefsByTab[String(addedTabId)],
        pendingRemoved:pending.blbSuitePendingMultiVerseRefsByTab[String(removedTabId)],
        activationResult:globalThis.__replacementActivationResult
      };
    }, {addedTabId,removedTabId,logicalKey,scriptKey});
    expect(result).toEqual({
      logical:undefined,
      intentionalAdded:false,
      intentionalRemoved:false,
      script:undefined,
      trackedAdded:undefined,
      trackedRemoved:undefined,
      pendingAdded:undefined,
      pendingRemoved:undefined,
      activationResult:false
    });
  } finally {
    await cleanupReplacementActivationGate(extensionWorker, extensionStorage, page);
    await extensionWorker.evaluate(async ({logicalKey,scriptKey,removedTabId}) => {
      blbLogicalTabRegistry.delete(logicalKey);
      scriptTaggerDestinationTabs.delete(scriptKey);
      intentionalNewBlbTabs.delete(removedTabId);
      await updateTrackedMultiVerseTabs(map => { delete map[String(removedTabId)]; });
      await updatePendingMultiVerseRefsByTab(map => { delete map[String(removedTabId)]; });
    }, {logicalKey,scriptKey,removedTabId:940202}).catch(() => {});
  }
});


test('original source tab closing during replacement migration preserves destination state', async ({
  context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  const sourcePage = await context.newPage();
  const destinationPage = await context.newPage();
  const logicalKey = 'replacement-source-close|logical';
  const scriptKey = 'replacement-source-close|script';
  let restoreMigration;
  let sourceTabId;
  let destinationTabId;
  try {
    await sourcePage.goto('https://example.com/?replacement-source-tab=1', {waitUntil:'domcontentloaded'});
    await destinationPage.goto('https://example.com/?replacement-destination-tab=1', {waitUntil:'domcontentloaded'});
    const ids = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return {
        source:tabs.find(tab => String(tab.url || '').includes('replacement-source-tab'))?.id,
        destination:tabs.find(tab => String(tab.url || '').includes('replacement-destination-tab'))?.id
      };
    });
    sourceTabId = ids.source;
    destinationTabId = ids.destination;
    expect(sourceTabId).toBeTruthy();
    expect(destinationTabId).toBeTruthy();
    await extensionWorker.evaluate(async ({sourceTabId,logicalKey,scriptKey}) => {
      await updateTrackedMultiVerseTabs(map => {
        map[String(sourceTabId)] = {marker:'source-close-migration'};
      });
      await updatePendingMultiVerseRefsByTab(map => {
        map[String(sourceTabId)] = [{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}];
      });
      blbLogicalTabRegistry.set(logicalKey, sourceTabId);
      intentionalNewBlbTabs.add(sourceTabId);
      scriptTaggerDestinationTabs.set(scriptKey, sourceTabId);
    }, {sourceTabId,logicalKey,scriptKey});

    await extensionWorker.evaluate(async sourceId => {
      const original = updateTrackedMultiVerseTabs;
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      globalThis.__sourceReplacementMigrationGate = {
        started,
        release:() => release(),
        restore:() => { updateTrackedMultiVerseTabs = original; }
      };
      updateTrackedMultiVerseTabs = mutator => original(async map => {
        if (!globalThis.__sourceReplacementMigrationGate.entered && map[String(sourceId)]) {
          globalThis.__sourceReplacementMigrationGate.entered = true;
          entered();
          await gate;
        }
        return mutator(map);
      });
    }, sourceTabId);
    await extensionWorker.evaluate(({destinationTabId,sourceTabId}) => {
      globalThis.__sourceReplacementMigrationPromise = handleReplacedTabIdentity(destinationTabId, sourceTabId);
    }, {destinationTabId,sourceTabId});
    await extensionWorker.evaluate(() => globalThis.__sourceReplacementMigrationGate.started);

    // The old source disappears while its replacement migration is queued.
    // Its onRemoved handler must not erase the pending refs before transfer.
    await sourcePage.close();
    await extensionWorker.evaluate(() => globalThis.__sourceReplacementMigrationGate.release());
    await extensionWorker.evaluate(async () => {
      await globalThis.__sourceReplacementMigrationPromise;
      await pendingMultiVerseTrackingUpdate;
      await pendingMultiVerseRefsUpdate;
      globalThis.__sourceReplacementMigrationGate.restore();
      delete globalThis.__sourceReplacementMigrationPromise;
    });

    const result = await extensionWorker.evaluate(async ({sourceTabId,destinationTabId,logicalKey,scriptKey}) => {
      const tracked = await getTrackedMultiVerseTabs();
      const pending = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
      return {
        logical:blbLogicalTabRegistry.get(logicalKey),
        intentionalSource:intentionalNewBlbTabs.has(sourceTabId),
        intentionalDestination:intentionalNewBlbTabs.has(destinationTabId),
        script:scriptTaggerDestinationTabs.get(scriptKey),
        trackedSource:tracked[String(sourceTabId)],
        trackedDestination:tracked[String(destinationTabId)],
        pendingSource:pending.blbSuitePendingMultiVerseRefsByTab[String(sourceTabId)],
        pendingDestination:pending.blbSuitePendingMultiVerseRefsByTab[String(destinationTabId)],
        migrationSourceCount:pendingReplacementSourceTabCounts.get(sourceTabId)
      };
    }, {sourceTabId,destinationTabId,logicalKey,scriptKey});
    expect(result).toEqual({
      logical:destinationTabId,
      intentionalSource:false,
      intentionalDestination:true,
      script:destinationTabId,
      trackedSource:undefined,
      trackedDestination:{marker:'source-close-migration'},
      pendingSource:undefined,
      pendingDestination:[{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}],
      migrationSourceCount:undefined
    });
  } finally {
    await extensionWorker.evaluate(() => {
      globalThis.__sourceReplacementMigrationGate?.release();
      globalThis.__sourceReplacementMigrationGate?.restore();
      delete globalThis.__sourceReplacementMigrationGate;
      delete globalThis.__sourceReplacementMigrationPromise;
    }).catch(() => {});
    await sourcePage.close().catch(() => {});
    await destinationPage.close().catch(() => {});
    await extensionStorage.set({pageSelectionButtonSites:{'example.com':false},doubleClickBlbSites:{}});
    await extensionWorker.evaluate(async ({sourceTabId,destinationTabId,logicalKey,scriptKey}) => {
      if (sourceTabId != null) {
        blbLogicalTabRegistry.delete(logicalKey);
        intentionalNewBlbTabs.delete(sourceTabId);
        intentionalNewBlbTabs.delete(destinationTabId);
        await updateTrackedMultiVerseTabs(map => {
          delete map[String(sourceTabId)]; delete map[String(destinationTabId)];
        });
        await updatePendingMultiVerseRefsByTab(map => {
          delete map[String(sourceTabId)]; delete map[String(destinationTabId)];
        });
      }
      scriptTaggerDestinationTabs.delete(scriptKey);
    }, {sourceTabId,destinationTabId,logicalKey,scriptKey}).catch(() => {});
    await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations().catch(() => {}));
  }
});


test('closing an intermediate replacement tab preserves state on the final replacement', async ({
  context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  const sourcePage = await context.newPage();
  const intermediatePage = await context.newPage();
  const finalPage = await context.newPage();
  const logicalKey = 'replacement-intermediate-close|logical';
  const scriptKey = 'replacement-intermediate-close|script';
  let ids;
  try {
    await sourcePage.goto('https://example.com/?replacement-chain-source=1', {waitUntil:'domcontentloaded'});
    await intermediatePage.goto('https://example.com/?replacement-chain-intermediate=1', {waitUntil:'domcontentloaded'});
    await finalPage.goto('https://example.com/?replacement-chain-final=1', {waitUntil:'domcontentloaded'});
    ids = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      const find = marker => tabs.find(tab => String(tab.url || '').includes(marker))?.id;
      return {source:find('replacement-chain-source'),intermediate:find('replacement-chain-intermediate'),final:find('replacement-chain-final')};
    });
    expect(ids.source).toBeTruthy();
    expect(ids.intermediate).toBeTruthy();
    expect(ids.final).toBeTruthy();
    await extensionWorker.evaluate(async ({source,logicalKey,scriptKey}) => {
      await updateTrackedMultiVerseTabs(map => { map[String(source)] = {marker:'intermediate-close-migration'}; });
      await updatePendingMultiVerseRefsByTab(map => {
        map[String(source)] = [{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}];
      });
      blbLogicalTabRegistry.set(logicalKey, source);
      intentionalNewBlbTabs.add(source);
      scriptTaggerDestinationTabs.set(scriptKey, source);
    }, {source:ids.source,logicalKey,scriptKey});

    await extensionWorker.evaluate(async sourceId => {
      const original = updateTrackedMultiVerseTabs;
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      globalThis.__intermediateReplacementMigrationGate = {
        started,
        release:() => release(),
        restore:() => { updateTrackedMultiVerseTabs = original; }
      };
      updateTrackedMultiVerseTabs = mutator => original(async map => {
        if (!globalThis.__intermediateReplacementMigrationGate.entered && map[String(sourceId)]) {
          globalThis.__intermediateReplacementMigrationGate.entered = true;
          entered();
          await gate;
        }
        return mutator(map);
      });
    }, ids.source);

    const first = extensionWorker.evaluate(({intermediate,source}) =>
      handleReplacedTabIdentity(intermediate,source), ids);
    await extensionWorker.evaluate(() => globalThis.__intermediateReplacementMigrationGate.started);
    // Start the second replacement while A→B is still blocked. B is now an
    // intermediate source whose onRemoved cleanup must not race B→C migration.
    const second = extensionWorker.evaluate(({final,intermediate}) =>
      handleReplacedTabIdentity(final,intermediate), ids);
    await intermediatePage.close();
    await extensionWorker.evaluate(() => globalThis.__intermediateReplacementMigrationGate.release());
    await Promise.all([first,second]);
    await extensionWorker.evaluate(async () => {
      await pendingMultiVerseTrackingUpdate;
      await pendingMultiVerseRefsUpdate;
      globalThis.__intermediateReplacementMigrationGate.restore();
    });

    const result = await extensionWorker.evaluate(async ({source,intermediate,final,logicalKey,scriptKey}) => {
      const tracked = await getTrackedMultiVerseTabs();
      const pending = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
      return {
        logical:blbLogicalTabRegistry.get(logicalKey),
        intentionalSource:intentionalNewBlbTabs.has(source),
        intentionalIntermediate:intentionalNewBlbTabs.has(intermediate),
        intentionalFinal:intentionalNewBlbTabs.has(final),
        script:scriptTaggerDestinationTabs.get(scriptKey),
        trackedSource:tracked[String(source)],
        trackedIntermediate:tracked[String(intermediate)],
        trackedFinal:tracked[String(final)],
        pendingSource:pending.blbSuitePendingMultiVerseRefsByTab[String(source)],
        pendingIntermediate:pending.blbSuitePendingMultiVerseRefsByTab[String(intermediate)],
        pendingFinal:pending.blbSuitePendingMultiVerseRefsByTab[String(final)],
        sourceMigrationCount:pendingReplacementSourceTabCounts.get(source),
        intermediateMigrationCount:pendingReplacementSourceTabCounts.get(intermediate)
      };
    }, {...ids,logicalKey,scriptKey});
    expect(result).toEqual({
      logical:ids.final,
      intentionalSource:false,
      intentionalIntermediate:false,
      intentionalFinal:true,
      script:ids.final,
      trackedSource:undefined,
      trackedIntermediate:undefined,
      trackedFinal:{marker:'intermediate-close-migration'},
      pendingSource:undefined,
      pendingIntermediate:undefined,
      pendingFinal:[{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}],
      sourceMigrationCount:undefined,
      intermediateMigrationCount:undefined
    });
  } finally {
    await extensionWorker.evaluate(() => {
      globalThis.__intermediateReplacementMigrationGate?.release();
      globalThis.__intermediateReplacementMigrationGate?.restore();
      delete globalThis.__intermediateReplacementMigrationGate;
    }).catch(() => {});
    await sourcePage.close().catch(() => {});
    await intermediatePage.close().catch(() => {});
    await finalPage.close().catch(() => {});
    await extensionStorage.set({pageSelectionButtonSites:{'example.com':false},doubleClickBlbSites:{}});
    await extensionWorker.evaluate(async ({source,intermediate,final,logicalKey,scriptKey}) => {
      blbLogicalTabRegistry.delete(logicalKey);
      scriptTaggerDestinationTabs.delete(scriptKey);
      for (const id of [source,intermediate,final]) {
        if (id == null) continue;
        intentionalNewBlbTabs.delete(id);
      }
      await updateTrackedMultiVerseTabs(map => {
        for (const id of [source,intermediate,final]) if (id != null) delete map[String(id)];
      });
      await updatePendingMultiVerseRefsByTab(map => {
        for (const id of [source,intermediate,final]) if (id != null) delete map[String(id)];
      });
    }, {...(ids || {}),logicalKey,scriptKey}).catch(() => {});
    await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations().catch(() => {}));
  }
});
