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

async function waitForTabToClose(extensionWorker, tabId) {
  await expect.poll(
    async () => extensionWorker.evaluate(async id => {
      try {
        await chrome.tabs.get(id);
        return true;
      } catch (_) {
        return false;
      }
    }, tabId),
    {timeout:5000}
  ).toBe(false);
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
  // Keep navigation-time onUpdated injection out of this test. The only
  // activation attempt should be the replacement recovery gated below.
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':false},
    doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  try {
    await page.goto('https://example.com/?replacement-preference-race=1', {waitUntil:'domcontentloaded'});
    const tabId = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return tabs.find(tab => String(tab.url || tab.pendingUrl || '').includes('replacement-preference-race'))?.id;
    });
    expect(tabId).toBeTruthy();

    // Install the gate before enabling the site. Enabling can itself trigger
    // an activation for an already-open tab, which must be held behind this gate.
    await installReplacementActivationGate(extensionWorker, tabId);
    await extensionStorage.set({pageSelectionButtonSites:{'example.com':true}});
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.started);
    await extensionWorker.evaluate(id => { globalThis.__replacementRecoveryPromise = handleReplacedTabIdentity(id, 940011); return true; }, tabId);

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
      return tabs.find(tab => String(tab.url || tab.pendingUrl || '').includes('replacement-close-race'))?.id;
    });
    expect(tabId).toBeTruthy();

    await installReplacementActivationGate(extensionWorker, tabId);
    await extensionWorker.evaluate(id => { globalThis.__replacementRecoveryPromise = handleReplacedTabIdentity(id, 940012); return true; }, tabId);
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.started);

    await page.close();
    await waitForTabToClose(extensionWorker, tabId);
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
    await waitForTabToClose(extensionWorker, addedTabId);
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


test('replacement migration retries each persisted state write after a transient storage failure', async ({
  extensionWorker
}) => {
  const ids = {source:940301,destination:940302};
  const logicalKey = 'replacement-storage-retry|logical';
  const scriptKey = 'replacement-storage-retry|script';
  const cases = [
    {storageKey:'blbSuiteMultiVerseTabSets',label:'tracked MultiVerse state'},
    {storageKey:'blbSuitePendingMultiVerseRefsByTab',label:'pending MultiVerse references'}
  ];
  try {
    await extensionWorker.evaluate(({destination}) => {
      globalThis.__replacementRetryOriginalGetLiveTabById = getLiveTabById;
      getLiveTabById = async id => [destination, destination + 2].includes(id) ? {id,url:'about:blank'} : null;
    }, ids);
    for (const [index, scenario] of cases.entries()) {
      const source = ids.source + index * 2;
      const destination = ids.destination + index * 2;
      await extensionWorker.evaluate(async ({source,destination,logicalKey,scriptKey}) => {
        await updateTrackedMultiVerseTabs(map => {
          map[String(source)] = {key:'source-set',updatedAt:1};
        });
        await updatePendingMultiVerseRefsByTab(map => {
          map[String(source)] = [{bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}];
        });
        blbLogicalTabRegistry.set(logicalKey, source);
        intentionalNewBlbTabs.add(source);
        scriptTaggerDestinationTabs.set(scriptKey, source);
      }, {source,destination,logicalKey,scriptKey});

      const result = await extensionWorker.evaluate(async ({source,destination,scenario,logicalKey,scriptKey}) => {
        const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
        let failed = false;
        let attempts = 0;
        chrome.storage.local.set = async items => {
          if (!failed && Object.prototype.hasOwnProperty.call(items, scenario.storageKey)) {
            failed = true;
            attempts++;
            throw new Error('simulated transient storage write failure');
          }
          if (Object.prototype.hasOwnProperty.call(items, scenario.storageKey)) attempts++;
          return originalSet(items);
        };
        try {
          await handleReplacedTabIdentity(destination, source);
          await pendingMultiVerseTrackingUpdate;
          await pendingMultiVerseRefsUpdate;
          const tracked = await getTrackedMultiVerseTabs();
          const pending = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
          return {
            failed,
            attempts,
            trackedSource:tracked[String(source)],
            trackedDestination:tracked[String(destination)],
            pendingSource:pending.blbSuitePendingMultiVerseRefsByTab[String(source)],
            pendingDestination:pending.blbSuitePendingMultiVerseRefsByTab[String(destination)],
            logical:blbLogicalTabRegistry.get(logicalKey),
            script:scriptTaggerDestinationTabs.get(scriptKey),
            intentionalSource:intentionalNewBlbTabs.has(source),
            intentionalDestination:intentionalNewBlbTabs.has(destination)
          };
        } finally {
          chrome.storage.local.set = originalSet;
        }
      }, {source,destination,scenario,logicalKey,scriptKey});

      expect(result.failed, scenario.label).toBe(true);
      expect(result.attempts, scenario.label).toBe(2);
      expect(result.trackedSource, scenario.label).toBeUndefined();
      expect(result.trackedDestination, scenario.label).toEqual({key:'source-set',updatedAt:1});
      expect(result.pendingSource, scenario.label).toBeUndefined();
      expect(result.pendingDestination, scenario.label).toEqual([
        {bookNumber:43,chapter:3,from:16,to:16,version:'kjv'}
      ]);
      expect(result.logical, scenario.label).toBe(destination);
      expect(result.script, scenario.label).toBe(destination);
      expect(result.intentionalSource, scenario.label).toBe(false);
      expect(result.intentionalDestination, scenario.label).toBe(true);

      await extensionWorker.evaluate(async ({source,destination,logicalKey,scriptKey}) => {
        blbLogicalTabRegistry.delete(logicalKey);
        scriptTaggerDestinationTabs.delete(scriptKey);
        intentionalNewBlbTabs.delete(source);
        intentionalNewBlbTabs.delete(destination);
        await updateTrackedMultiVerseTabs(map => {
          delete map[String(source)];
          delete map[String(destination)];
        });
        await updatePendingMultiVerseRefsByTab(map => {
          delete map[String(source)];
          delete map[String(destination)];
        });
      }, {source,destination,logicalKey,scriptKey});
    }
  } finally {
    await extensionWorker.evaluate(() => {
      if (globalThis.__replacementRetryOriginalGetLiveTabById) {
        getLiveTabById = globalThis.__replacementRetryOriginalGetLiveTabById;
        delete globalThis.__replacementRetryOriginalGetLiveTabById;
      }
      delete globalThis.__replacementRetryTestIds;
    }).catch(() => {});
    await extensionWorker.evaluate(async ({ids,logicalKey,scriptKey}) => {
      blbLogicalTabRegistry.delete(logicalKey);
      scriptTaggerDestinationTabs.delete(scriptKey);
      for (const id of ids) intentionalNewBlbTabs.delete(id);
      await updateTrackedMultiVerseTabs(map => {
        for (const id of ids) delete map[String(id)];
      });
      await updatePendingMultiVerseRefsByTab(map => {
        for (const id of ids) delete map[String(id)];
      });
    }, {ids:[940301,940302,940303,940304],logicalKey,scriptKey}).catch(() => {});
  }
});



test('replacement migration preserves destination state and merges unique pending references', async ({
  extensionWorker
}) => {
  const source = 940401;
  const destination = 940402;
  const logicalKey = 'replacement-conflicting-state|logical';
  const scriptKey = 'replacement-conflicting-state|script';
  const destinationRef = {
    bookNumber:43, chapter:3, from:16, to:16, version:'kjv'
  };
  const sourceDuplicateWithDifferentPropertyOrder = {
    version:'KJV', to:16, from:16, chapter:3, bookNumber:43
  };
  const sourceOnlyRef = {
    bookNumber:43, chapter:4, from:1, to:2, version:'kjv'
  };
  try {
    await extensionWorker.evaluate(({destination}) => {
      globalThis.__replacementConflictOriginalGetLiveTabById = getLiveTabById;
      getLiveTabById = async id => id === destination ? {id,url:'about:blank'} : null;
    }, {destination});
    await extensionWorker.evaluate(async ({source,destination,logicalKey,scriptKey,destinationRef,sourceDuplicateWithDifferentPropertyOrder,sourceOnlyRef}) => {
      await updateTrackedMultiVerseTabs(map => {
        map[String(source)] = {key:'source-reservation',updatedAt:1};
        map[String(destination)] = {key:'destination-reservation',updatedAt:2};
      });
      await updatePendingMultiVerseRefsByTab(map => {
        map[String(destination)] = [destinationRef];
        map[String(source)] = [sourceDuplicateWithDifferentPropertyOrder, sourceOnlyRef];
      });
      blbLogicalTabRegistry.set(logicalKey, source);
      intentionalNewBlbTabs.add(source);
      scriptTaggerDestinationTabs.set(scriptKey, source);
    }, {source,destination,logicalKey,scriptKey,destinationRef,sourceDuplicateWithDifferentPropertyOrder,sourceOnlyRef});

    await extensionWorker.evaluate(({source,destination}) =>
      handleReplacedTabIdentity(destination, source), {source,destination});
    await extensionWorker.evaluate(async () => {
      await pendingMultiVerseTrackingUpdate;
      await pendingMultiVerseRefsUpdate;
    });
    const result = await extensionWorker.evaluate(async ({source,destination,logicalKey,scriptKey}) => {
      const tracked = await getTrackedMultiVerseTabs();
      const pending = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
      return {
        trackedSource:tracked[String(source)],
        trackedDestination:tracked[String(destination)],
        pendingSource:pending.blbSuitePendingMultiVerseRefsByTab[String(source)],
        pendingDestination:pending.blbSuitePendingMultiVerseRefsByTab[String(destination)],
        logical:blbLogicalTabRegistry.get(logicalKey),
        script:scriptTaggerDestinationTabs.get(scriptKey),
        intentionalSource:intentionalNewBlbTabs.has(source),
        intentionalDestination:intentionalNewBlbTabs.has(destination)
      };
    }, {source,destination,logicalKey,scriptKey});

    expect(result.trackedSource).toBeUndefined();
    expect(result.trackedDestination).toEqual({key:'destination-reservation',updatedAt:2});
    expect(result.pendingSource).toBeUndefined();
    expect(result.pendingDestination).toEqual([destinationRef, sourceOnlyRef]);
    expect(result.logical).toBe(destination);
    expect(result.script).toBe(destination);
    expect(result.intentionalSource).toBe(false);
    expect(result.intentionalDestination).toBe(true);
  } finally {
    await extensionWorker.evaluate(() => {
      if (globalThis.__replacementConflictOriginalGetLiveTabById) {
        getLiveTabById = globalThis.__replacementConflictOriginalGetLiveTabById;
        delete globalThis.__replacementConflictOriginalGetLiveTabById;
      }
    }).catch(() => {});
    await extensionWorker.evaluate(async ({source,destination,logicalKey,scriptKey}) => {
      blbLogicalTabRegistry.delete(logicalKey);
      scriptTaggerDestinationTabs.delete(scriptKey);
      intentionalNewBlbTabs.delete(source);
      intentionalNewBlbTabs.delete(destination);
      await updateTrackedMultiVerseTabs(map => {
        delete map[String(source)];
        delete map[String(destination)];
      });
      await updatePendingMultiVerseRefsByTab(map => {
        delete map[String(source)];
        delete map[String(destination)];
      });
    }, {source,destination,logicalKey,scriptKey}).catch(() => {});
  }
});


test('replacement chains wait for earlier transient storage retries before migrating and cleaning source state', async ({
  extensionWorker
}) => {
  const cases = [
    {storageKey:'blbSuiteMultiVerseTabSets',label:'tracked MultiVerse state'},
    {storageKey:'blbSuitePendingMultiVerseRefsByTab',label:'pending MultiVerse references'}
  ];
  const ids = {source:940501, intermediate:940502, final:940503};
  const logicalKey = 'replacement-overlapping-retry|logical';
  const scriptKey = 'replacement-overlapping-retry|script';
  try {
    await extensionWorker.evaluate(({intermediate,final}) => {
      globalThis.__replacementChainOriginalGetLiveTabById = getLiveTabById;
      getLiveTabById = async id => [940502,940503,940512,940513].includes(id) ? {id,url:'about:blank'} : null;
    }, ids);

    for (const [index, scenario] of cases.entries()) {
      const offset = index * 10;
      const source = ids.source + offset;
      const intermediate = ids.intermediate + offset;
      const final = ids.final + offset;
      const reference = {bookNumber:43,chapter:3,from:16,to:16,version:'kjv'};
      await extensionWorker.evaluate(async ({source,logicalKey,scriptKey,reference}) => {
        await updateTrackedMultiVerseTabs(map => {
          map[String(source)] = {key:'chain-reservation',updatedAt:1};
        });
        await updatePendingMultiVerseRefsByTab(map => {
          map[String(source)] = [reference];
        });
        blbLogicalTabRegistry.set(logicalKey, source);
        intentionalNewBlbTabs.add(source);
        scriptTaggerDestinationTabs.set(scriptKey, source);
      }, {source,logicalKey,scriptKey,reference});

      await extensionWorker.evaluate(async ({storageKey}) => {
        const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        let failed = false;
        chrome.storage.local.set = async items => {
          if (!failed && Object.prototype.hasOwnProperty.call(items, storageKey)) {
            failed = true;
            entered();
            await gate;
            throw new Error('simulated delayed transient replacement write failure');
          }
          return originalSet(items);
        };
        globalThis.__replacementChainWriteGate = {
          started,
          release:() => release(),
          restore:() => { chrome.storage.local.set = originalSet; },
          get failed() { return failed; }
        };
      }, scenario);

      await extensionWorker.evaluate(({intermediate,source}) => {
        globalThis.__replacementChainFirst = handleReplacedTabIdentity(intermediate,source);
        return true;
      }, {intermediate,source});
      await extensionWorker.evaluate(() => globalThis.__replacementChainWriteGate.started);
      await extensionWorker.evaluate(({final,intermediate}) => {
        globalThis.__replacementChainSecond = handleReplacedTabIdentity(final,intermediate);
        return true;
      }, {final,intermediate});

      const queuedState = await extensionWorker.evaluate(({intermediate}) => ({
        intermediateSourceCount:pendingReplacementSourceTabCounts.get(intermediate) || 0,
        queuePending:pendingReplacementMigrationQueue instanceof Promise
      }), {intermediate});
      expect(queuedState.intermediateSourceCount).toBeGreaterThan(0);
      expect(queuedState.queuePending).toBe(true);

      await extensionWorker.evaluate(() => {
        globalThis.__replacementChainWriteGate.release();
        globalThis.__replacementChainWriteGate.restore();
      });
      await extensionWorker.evaluate(async () => {
        await Promise.all([globalThis.__replacementChainFirst,globalThis.__replacementChainSecond].filter(Boolean));
        delete globalThis.__replacementChainFirst;
        delete globalThis.__replacementChainSecond;
      });
      await extensionWorker.evaluate(async () => {
        await pendingMultiVerseTrackingUpdate;
        await pendingMultiVerseRefsUpdate;
        await pendingReplacementMigrationQueue;
      });

      const result = await extensionWorker.evaluate(async ({source,intermediate,final,logicalKey,scriptKey}) => {
        const tracked = await getTrackedMultiVerseTabs();
        const pending = await chrome.storage.local.get({blbSuitePendingMultiVerseRefsByTab:{}});
        return {
          trackedSource:tracked[String(source)],
          trackedIntermediate:tracked[String(intermediate)],
          trackedFinal:tracked[String(final)],
          pendingSource:pending.blbSuitePendingMultiVerseRefsByTab[String(source)],
          pendingIntermediate:pending.blbSuitePendingMultiVerseRefsByTab[String(intermediate)],
          pendingFinal:pending.blbSuitePendingMultiVerseRefsByTab[String(final)],
          logical:blbLogicalTabRegistry.get(logicalKey),
          script:scriptTaggerDestinationTabs.get(scriptKey),
          sourceCount:pendingReplacementSourceTabCounts.get(source),
          intermediateCount:pendingReplacementSourceTabCounts.get(intermediate)
        };
      }, {source,intermediate,final,logicalKey,scriptKey});

      expect(result.trackedSource, scenario.label).toBeUndefined();
      expect(result.trackedIntermediate, scenario.label).toBeUndefined();
      expect(result.trackedFinal, scenario.label).toEqual({key:'chain-reservation',updatedAt:1});
      expect(result.pendingSource, scenario.label).toBeUndefined();
      expect(result.pendingIntermediate, scenario.label).toBeUndefined();
      expect(result.pendingFinal, scenario.label).toEqual([reference]);
      expect(result.logical, scenario.label).toBe(final);
      expect(result.script, scenario.label).toBe(final);
      expect(result.sourceCount, scenario.label).toBeUndefined();
      expect(result.intermediateCount, scenario.label).toBeUndefined();

      await extensionWorker.evaluate(async ({source,intermediate,final,logicalKey,scriptKey}) => {
        blbLogicalTabRegistry.delete(logicalKey);
        scriptTaggerDestinationTabs.delete(scriptKey);
        for (const id of [source,intermediate,final]) intentionalNewBlbTabs.delete(id);
        await updateTrackedMultiVerseTabs(map => {
          for (const id of [source,intermediate,final]) delete map[String(id)];
        });
        await updatePendingMultiVerseRefsByTab(map => {
          for (const id of [source,intermediate,final]) delete map[String(id)];
        });
      }, {source,intermediate,final,logicalKey,scriptKey});
      await extensionWorker.evaluate(() => {
        globalThis.__replacementChainWriteGate?.restore();
        delete globalThis.__replacementChainWriteGate;
      });
    }
  } finally {
    await extensionWorker.evaluate(() => {
      globalThis.__replacementChainWriteGate?.release();
      globalThis.__replacementChainWriteGate?.restore();
      delete globalThis.__replacementChainWriteGate;
      if (globalThis.__replacementChainOriginalGetLiveTabById) {
        getLiveTabById = globalThis.__replacementChainOriginalGetLiveTabById;
        delete globalThis.__replacementChainOriginalGetLiveTabById;
      }
    }).catch(() => {});
    await extensionWorker.evaluate(async ({ids,logicalKey,scriptKey}) => {
      blbLogicalTabRegistry.delete(logicalKey);
      scriptTaggerDestinationTabs.delete(scriptKey);
      for (const id of ids) intentionalNewBlbTabs.delete(id);
      await updateTrackedMultiVerseTabs(map => {
        for (const id of ids) delete map[String(id)];
      });
      await updatePendingMultiVerseRefsByTab(map => {
        for (const id of ids) delete map[String(id)];
      });
    }, {ids:[940501,940502,940503,940511,940512,940513],logicalKey,scriptKey}).catch(() => {});
  }
});
