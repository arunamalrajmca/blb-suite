const { test, expect } = require('./fixtures');

test('tab activation and active-tab navigation synchronize the global web/PDF selection menus', async ({
  extensionWorker
}) => {
  const previous = await extensionWorker.evaluate(async () => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false
  }));

  const result = await extensionWorker.evaluate(async settings => {
    const originalUpdate = chrome.contextMenus.update;
    const originalWebKnownPresent = selectionMenuKnownPresent;
    const originalPdfKnownPresent = pdfSelectionMenuKnownPresent;
    const originalPdfVisibilitySync = syncPdfSelectionContextMenuVisibility;
    const originalSelectionPermissionCheck = hasSelectionActionPermissionForTab;
    const createdTabIds = [];
    const createdWindowIds = [];
    const updates = [];
    let pdfVisibilitySyncCalls = 0;
    let recordFocusEvent;

    try {
      selectionMenuKnownPresent = true;
      pdfSelectionMenuKnownPresent = true;
      syncPdfSelectionContextMenuVisibility = async (...args) => {
        pdfVisibilitySyncCalls += 1;
        return originalPdfVisibilitySync(...args);
      };
      // This test isolates menu lifecycle behavior; host-grant UX is covered
      // separately, so make the selected fixture host eligible deterministically.
      hasSelectionActionPermissionForTab = async tab =>
        new URL(tab?.url || 'about:blank').hostname === 'example.com';
      chrome.contextMenus.update = async (id, details) => {
        updates.push({id, ...details, stack:new Error().stack});
      };

      const enabledTab = await chrome.tabs.create({
        url:'https://example.com/',
        active:false
      });
      createdTabIds.push(enabledTab.id);
      const inactiveTab = await chrome.tabs.create({
        url:'about:blank',
        active:false
      });
      createdTabIds.push(inactiveTab.id);

      await chrome.storage.local.set({
        masterEnabled:true,
        redirectEnabled:false,
        pageSelectionButtonSites:{'example.com':true},
        doubleClickBlbSites:{}
      });
      await runtimeContentScriptReconciliationQueue;
      // The PDF menu is installed asynchronously during worker startup. Make
      // its real installation deterministic before asserting activation
      // synchronizes both global menu items.
      await installPdfSelectionContextMenu();
      if (!pdfSelectionMenuKnownPresent) {
        throw new Error('PDF selection menu was not installed for the lifecycle test');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      updates.length = 0;

      if (!chrome.tabs.onActivated.hasListeners() || !chrome.tabs.onUpdated.hasListeners()) {
        throw new Error('Expected tab activation and update listeners to be registered');
      }

      // A real tab activation must make both global menus reflect the active tab.
      await chrome.tabs.update(enabledTab.id, {active:true});
      for (let attempt=0; attempt<100 && updates.filter(item =>
        item.id === 'blb-suite-web-selection'
      ).length < 2; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const activationUpdates = [...updates];
      const activationMenuVisibility = Object.fromEntries(
        activationUpdates
          .filter(item =>
            (item.id === 'blb-suite-web-selection' || item.id === 'blb-suite-web-selection') &&
            typeof item.visible === 'boolean'
          )
          .map(item => [item.id, item.visible])
      );
      const activationShowsWebMenu = activationUpdates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      );
      // Web and PDF selections intentionally share one browser-owned menu ID.
      // Observe the PDF synchronizer itself rather than expecting a second
      // native update for an item that is now shared by both contexts.
      const activationSynchronizesPdfMenu = pdfVisibilitySyncCalls > 0;

      // A navigation in an inactive tab must not change global menu visibility.
      updates.length = 0;
      await chrome.tabs.update(inactiveTab.id, {url:'https://www.gov.scot/'});
      for (let attempt=0; attempt<100; attempt++) {
        const tab = await chrome.tabs.get(inactiveTab.id);
        if (tab.status === 'complete' && tab.url === 'https://www.gov.scot/') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      const inactiveNavigationUpdates = [...updates];

      // Navigating the active tab to a sensitive host must hide the web menu.
      updates.length = 0;
      await chrome.tabs.update(enabledTab.id, {url:'https://www.gov.scot/'});
      for (let attempt=0; attempt<100 && !updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === false
      ); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const activeNavigationHidesWebMenu = updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === false
      );

      // The production code now has one browser-owned context-menu item for
      // both web and PDF selections. Exercise the replacement helper's active-
      // tab acceptance contract here; activation/navigation above independently
      // verify visibility updates. Do not count duplicate updates to the same
      // native menu ID as separate web and PDF menu installations.
      const replacementTab = await chrome.tabs.create({url:'https://example.com/',active:false});
      createdTabIds.push(replacementTab.id);
      await chrome.tabs.update(replacementTab.id,{active:true});
      for (let attempt=0; attempt<100; attempt++) {
        const activeTabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
        if (activeTabs[0]?.id === replacementTab.id) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const replacementSynced = await syncSelectionMenusAfterTabReplacement(replacementTab.id);

      // Replacements in a background tab must not change global menu state.
      updates.length = 0;
      const backgroundReplacementIgnored = !(await syncSelectionMenusAfterTabReplacement(inactiveTab.id));
      const backgroundReplacementUpdates = [...updates];

      // Focusing a different browser window must also refresh the global menus;
      // the active tab inside either window can remain unchanged.
      const originalWindowId = replacementTab.windowId;
      const focusEvents = [];
      recordFocusEvent = windowId => focusEvents.push(windowId);
      chrome.windows.onFocusChanged.addListener(recordFocusEvent);
      const otherWindow = await chrome.windows.create({url:'https://www.gov.scot/',focused:false});
      if (!otherWindow?.id) throw new Error('Could not create the secondary test window');
      createdWindowIds.push(otherWindow.id);
      updates.length = 0;
      await chrome.windows.update(otherWindow.id,{focused:true});
      for (let attempt=0; attempt<50 && !updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === false
      ); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const focusChangeHidesWebMenu = updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === false
      );
      // Closing the temporary focused window deterministically returns focus
      // to the original browser window in headless Chromium. Chrome can emit
      // only WINDOW_ID_NONE during this handoff, so onRemoved must resync menus.
      // A direct windows.update({focused:true}) can be ignored by the window manager
      // during the transient WINDOW_ID_NONE handoff.
      updates.length = 0;
      await chrome.windows.remove(otherWindow.id);
      let focusedWindowId = null;
      for (let attempt=0; attempt<100; attempt++) {
        const focusedWindow = await chrome.windows.getLastFocused();
        focusedWindowId = focusedWindow?.id ?? null;
        if (focusedWindowId === originalWindowId) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      for (let attempt=0; attempt<100 && !updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      ); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const focusChangeShowsWebMenu = updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      );
      chrome.windows.onFocusChanged.removeListener(recordFocusEvent);

      return {
        activationShowsWebMenu,
        activationSynchronizesPdfMenu,
        activationMenuVisibility,
        inactiveNavigationUpdates,
        activeNavigationHidesWebMenu,
        replacementSynced,
        replacementTabId:replacementTab.id,
        backgroundReplacementIgnored,
        backgroundReplacementUpdates,
        focusChangeHidesWebMenu,
        focusChangeShowsWebMenu,
        focusHandoffEmittedNone:focusEvents.includes(chrome.windows.WINDOW_ID_NONE),
        focusEvents,
        updates,
        originalWindowId,
        focusedWindowId
      };
    } finally {
      chrome.contextMenus.update = originalUpdate;
      selectionMenuKnownPresent = originalWebKnownPresent;
      pdfSelectionMenuKnownPresent = originalPdfKnownPresent;
      syncPdfSelectionContextMenuVisibility = originalPdfVisibilitySync;
      hasSelectionActionPermissionForTab = originalSelectionPermissionCheck;
      if (recordFocusEvent) {
        chrome.windows.onFocusChanged.removeListener(recordFocusEvent);
      }
      await Promise.all(createdTabIds.map(id => chrome.tabs.remove(id).catch(() => {})));
      await Promise.all(createdWindowIds.map(id => chrome.windows.remove(id).catch(() => {})));
      await chrome.storage.local.set(settings);
      await runtimeContentScriptReconciliationQueue;
    }
  }, previous);

  expect(result.activationShowsWebMenu).toBe(true);
  expect(result.activationSynchronizesPdfMenu).toBe(true);
  const inactiveNavigationMenuUpdates = result.inactiveNavigationUpdates.filter(item =>
    item.id === 'blb-suite-web-selection'
  );
  expect(
    inactiveNavigationMenuUpdates.every(item =>
      result.activationMenuVisibility[item.id] === item.visible
    ),
    JSON.stringify({
      activationMenuVisibility:result.activationMenuVisibility,
      inactiveNavigationMenuUpdates
    }, null, 2)
  ).toBe(true);
  expect(result.activeNavigationHidesWebMenu).toBe(true);
  expect(result.replacementSynced).toBe(true);
  expect(result.backgroundReplacementIgnored).toBe(true);
  expect(result.backgroundReplacementUpdates).toEqual([]);
  expect(result.focusChangeHidesWebMenu).toBe(true);
  expect(result.focusedWindowId).toBe(result.originalWindowId);
  expect(
    result.focusHandoffEmittedNone,
    JSON.stringify({focusEvents:result.focusEvents}, null, 2)
  ).toBe(true);
  expect(
    result.focusChangeShowsWebMenu,
    JSON.stringify({
      focusEvents:result.focusEvents,
      originalWindowId:result.originalWindowId,
      focusedWindowId:result.focusedWindowId,
      updates:result.updates
    }, null, 2)
  ).toBe(true);
});


test('PDF selection menu ignores stale asynchronous visibility results', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => {
    const originalUpdate = chrome.contextMenus.update;
    const originalKnownPresent = pdfSelectionMenuKnownPresent;
    const originalPdfViewerCheck = isPdfViewerTab;
    const originalPageEnabled = isPageButtonEnabledForHostname;
    const originalSuiteEnabled = isSuiteEnabled;
    const updates = [];
    let signalSlowStarted;
    const slowStarted = new Promise(resolve => { signalSlowStarted = resolve; });
    let releaseSlow;
    const slowGate = new Promise(resolve => { releaseSlow = resolve; });
    try {
      pdfSelectionMenuKnownPresent = true;
      chrome.contextMenus.update = async (id, details) => { updates.push({id,...details}); };
      isPdfViewerTab = () => true;
      isSuiteEnabled = async () => true;
      // Direct HTTP(S) PDFs and browser-managed PDFs share the synthetic
      // __blb_pdf_viewer__ preference key. Distinguish the two concurrent tab
      // snapshots by title, not by the preference key they intentionally share.
      isPageButtonEnabledForHostname = async (_siteKey, title) => {
        if (title === 'Slow PDF') {
          signalSlowStarted();
          await slowGate;
          return false;
        }
        return title === 'Fast PDF';
      };

      const slow = syncPdfSelectionContextMenuVisibility({url:'https://slow.example/document.pdf',title:'Slow PDF'});
      await slowStarted;
      await syncPdfSelectionContextMenuVisibility({url:'https://fast.example/document.pdf',title:'Fast PDF'});
      releaseSlow();
      await slow;
      return [...updates];
    } finally {
      releaseSlow?.();
      chrome.contextMenus.update = originalUpdate;
      pdfSelectionMenuKnownPresent = originalKnownPresent;
      isPdfViewerTab = originalPdfViewerCheck;
      isPageButtonEnabledForHostname = originalPageEnabled;
      isSuiteEnabled = originalSuiteEnabled;
    }
  });

  expect(result).toEqual([{id:'blb-suite-web-selection',visible:true}]);
});

test('web selection menu ignores stale asynchronous visibility results', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => {
    const originalUpdate = chrome.contextMenus.update;
    const originalKnownPresent = selectionMenuKnownPresent;
    const originalEligibilityCheck = shouldShowBlbContextMenu;
    const updates = [];
    let signalSlowStarted;
    const slowStarted = new Promise(resolve => { signalSlowStarted = resolve; });
    let releaseSlow;
    const slowGate = new Promise(resolve => { releaseSlow = resolve; });
    try {
      selectionMenuKnownPresent = true;
      chrome.contextMenus.update = async (id, details) => { updates.push({id,...details}); };
      shouldShowBlbContextMenu = async tab => {
        if (tab?.id === 1) {
          signalSlowStarted();
          await slowGate;
          return false;
        }
        return tab?.id === 2;
      };

      const slow = syncWebSelectionContextMenuVisibility({id:1,url:'https://slow.example/'}, false);
      await slowStarted;
      await syncWebSelectionContextMenuVisibility({id:2,url:'https://fast.example/'}, false);
      releaseSlow();
      await slow;
      return [...updates];
    } finally {
      releaseSlow?.();
      chrome.contextMenus.update = originalUpdate;
      selectionMenuKnownPresent = originalKnownPresent;
      shouldShowBlbContextMenu = originalEligibilityCheck;
    }
  });

  expect(result).toEqual([{id:'blb-suite-web-selection',visible:true}]);
});



test('right-click action remains usable after the service worker restarts with a persisted visible menu', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => {
    const originals = {
      update:chrome.contextMenus.update,
      knownPresent:selectionMenuKnownPresent,
      suiteEnabled:isSuiteEnabled,
      activeSelection:getActiveTabSelection,
      eligibility:shouldShowBlbContextMenu,
      contextualReference:getContextualSelectionReference,
      openAction:openSharedSelectionAction,
      clearSelection:clearPageSelectionAfterBlbAction
    };
    const updates = [];
    const actions = [];
    try {
      // Simulate a fresh MV3 worker: its in-memory flag resets, while the
      // browser-owned context-menu item and its visible state survive.
      selectionMenuKnownPresent = false;
      chrome.contextMenus.update = async (id, details) => { updates.push({id,...details}); };
      isSuiteEnabled = async () => true;
      getActiveTabSelection = async () => 'Romans 8:28';
      shouldShowBlbContextMenu = async () => true;
      getContextualSelectionReference = async () => null;
      openSharedSelectionAction = async options => { actions.push(options); };
      clearPageSelectionAfterBlbAction = async () => {};
      const tab = {id:77,url:'https://example.com/article',title:'Example article'};
      const menuReady = await ensureWebSelectionContextMenu();
      await handleBlbSelectionContextMenuClick({
        menuItemId:'blb-suite-web-selection',
        selectionText:'Romans 8:28'
      },tab);
      return {menuReady,updates,actions};
    } finally {
      chrome.contextMenus.update = originals.update;
      selectionMenuKnownPresent = originals.knownPresent;
      isSuiteEnabled = originals.suiteEnabled;
      getActiveTabSelection = originals.activeSelection;
      shouldShowBlbContextMenu = originals.eligibility;
      getContextualSelectionReference = originals.contextualReference;
      openSharedSelectionAction = originals.openAction;
      clearPageSelectionAfterBlbAction = originals.clearSelection;
    }
  });
  expect(result.menuReady).toBe(true);
  expect(result.updates).toEqual([
    {id:'blb-suite-web-selection',title:'Show on BLB\tAlt+B',documentUrlPatterns:[]}
  ]);
  expect(result.actions).toHaveLength(1);
  expect(result.actions[0]).toMatchObject({
    tabId:77,
    tabUrl:'https://example.com/article',
    text:'Romans 8:28',
    behavior:{activeIfNew:true,activateExisting:true},
    contextualReferenceResolved:true
  });
});

test('worker restart preserves web menu visibility while click-time eligibility still blocks sensitive hosts', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => {
    const originalUpdate = chrome.contextMenus.update;
    const originalKnownPresent = selectionMenuKnownPresent;
    const originalSuiteEnabled = isSuiteEnabled;
    const originalPermissionCheck = hasSelectionActionPermissionForTab;
    const originalPageEnabled = isPageButtonEnabledForHostname;
    const updates = [];
    try {
      // A restarted MV3 worker begins with this in-memory flag reset even
      // though the browser-owned context-menu item and its visibility persist.
      selectionMenuKnownPresent = false;
      chrome.contextMenus.update = async (id, details) => { updates.push({id,...details}); };
      const ensured = await ensureWebSelectionContextMenu();

      isSuiteEnabled = async () => true;
      hasSelectionActionPermissionForTab = async () => true;
      isPageButtonEnabledForHostname = async () => true;
      const sensitiveHostAllowed = await shouldShowBlbContextMenu(
        {id:77,url:'https://github.com/arunamalrajmca/blb-suite'},
        'John 3:16'
      );
      return {
        ensured,
        update:updates.find(item => item.id === 'blb-suite-web-selection'),
        sensitiveHostAllowed
      };
    } finally {
      chrome.contextMenus.update = originalUpdate;
      selectionMenuKnownPresent = originalKnownPresent;
      isSuiteEnabled = originalSuiteEnabled;
      hasSelectionActionPermissionForTab = originalPermissionCheck;
      isPageButtonEnabledForHostname = originalPageEnabled;
    }
  });

  expect(result.ensured).toBe(true);
  expect(result.update).toEqual({id:'blb-suite-web-selection',title:'Show on BLB\tAlt+B',documentUrlPatterns:[]});
  expect(result.sensitiveHostAllowed).toBe(false);
});


test('concurrent worker-restart menu initialization creates the persistent item only once', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => {
    const originals = {
      update:chrome.contextMenus.update,
      create:chrome.contextMenus.create,
      knownPresent:selectionMenuKnownPresent,
      ensurePromise:selectionMenuEnsurePromise
    };
    let updateCalls = 0;
    let createCalls = 0;
    try {
      // Drain any startup/activation initialization already in flight before
      // replacing the shared lock. Otherwise the test itself can discard a
      // real pending promise and manufacture a second concurrent create().
      if (selectionMenuEnsurePromise) await selectionMenuEnsurePromise;
      selectionMenuKnownPresent = false;
      selectionMenuEnsurePromise = null;
      chrome.contextMenus.update = async (_id, details = {}) => {
        // Visibility synchronization also calls update(); count only the
        // existence/title refresh performed by ensureWebSelectionContextMenu.
        if (Object.hasOwn(details, 'title')) {
          updateCalls++;
          throw new Error('Cannot find menu item');
        }
      };
      chrome.contextMenus.create = async details => {
        createCalls++;
        await new Promise(resolve => setTimeout(resolve, 25));
        return details.id;
      };
      const results = await Promise.all(Array.from({length:8}, () => ensureWebSelectionContextMenu()));
      return {results,updateCalls,createCalls,knownPresent:selectionMenuKnownPresent};
    } finally {
      chrome.contextMenus.update = originals.update;
      chrome.contextMenus.create = originals.create;
      selectionMenuKnownPresent = originals.knownPresent;
      selectionMenuEnsurePromise = originals.ensurePromise;
    }
  });
  expect(result.results).toEqual(Array(8).fill(true));
  expect(result.updateCalls).toBe(1);
  expect(result.createCalls).toBe(1);
  expect(result.knownPresent).toBe(true);
});

test('duplicate-ID creation race adopts the existing persistent selection menu', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => {
    const originals = {
      update:chrome.contextMenus.update,
      create:chrome.contextMenus.create,
      knownPresent:selectionMenuKnownPresent,
      ensurePromise:selectionMenuEnsurePromise
    };
    let updateCalls = 0;
    let createCalls = 0;
    try {
      selectionMenuKnownPresent = false;
      selectionMenuEnsurePromise = null;
      chrome.contextMenus.update = async (_id, details = {}) => {
        if (!Object.hasOwn(details, 'title')) return;
        updateCalls++;
        if (updateCalls === 1) throw new Error('Cannot find menu item');
      };
      chrome.contextMenus.create = async () => {
        createCalls++;
        throw new Error('Cannot create item with duplicate id blb-suite-web-selection');
      };
      const ensured = await ensureWebSelectionContextMenu();
      return {ensured,updateCalls,createCalls,knownPresent:selectionMenuKnownPresent};
    } finally {
      chrome.contextMenus.update = originals.update;
      chrome.contextMenus.create = originals.create;
      selectionMenuKnownPresent = originals.knownPresent;
      selectionMenuEnsurePromise = originals.ensurePromise;
    }
  });
  expect(result).toEqual({ensured:true,updateCalls:2,createCalls:1,knownPresent:true});
});
