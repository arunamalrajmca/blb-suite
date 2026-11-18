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
    const originalSelectionPermissionCheck = hasSelectionActionPermissionForTab;
    const createdTabIds = [];
    const createdWindowIds = [];
    const updates = [];
    let recordFocusEvent;

    try {
      selectionMenuKnownPresent = true;
      pdfSelectionMenuKnownPresent = true;
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
      for (let attempt=0; attempt<100 && (!updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      ) || !updates.some(item => item.id === 'blb-suite-pdf-selection')); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const activationUpdates = [...updates];
      const activationMenuVisibility = Object.fromEntries(
        activationUpdates
          .filter(item =>
            (item.id === 'blb-suite-web-selection' || item.id === 'blb-suite-pdf-selection') &&
            typeof item.visible === 'boolean'
          )
          .map(item => [item.id, item.visible])
      );
      const activationShowsWebMenu = activationUpdates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      );
      const activationSynchronizesPdfMenu = activationUpdates.some(item =>
        item.id === 'blb-suite-pdf-selection'
      );

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

      // A replacement of the active tab must independently resynchronize both
      // menus even when no subsequent activation/navigation event is observed.
      const replacementTab = await chrome.tabs.create({url:'https://example.com/',active:false});
      createdTabIds.push(replacementTab.id);
      await chrome.tabs.update(replacementTab.id,{active:true});
      // Let the real activation listener finish before isolating the explicit
      // replacement synchronization; otherwise its asynchronous visibility
      // update can race this direct helper invocation and invalidate its result.
      for (let attempt=0; attempt<100 && (
        !updates.some(item => item.id === 'blb-suite-web-selection' && item.visible === true) ||
        !updates.some(item => item.id === 'blb-suite-pdf-selection')
      ); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Activation drives the two menu synchronizers independently. Wait for
      // both updates and let queued activation work settle before clearing the
      // capture, otherwise a late activation update can race the replacement
      // helper and make its result nondeterministic.
      await new Promise(resolve => setTimeout(resolve, 100));
      const activeTabBeforeReplacementSync = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      updates.length = 0;
      const replacementSynced = await syncSelectionMenusAfterTabReplacement(replacementTab.id);
      const replacementShowsWebMenu = updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      );
      const replacementSynchronizesPdfMenu = updates.some(item =>
        item.id === 'blb-suite-pdf-selection'
      );
      const replacementUpdates = [...updates];

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
        activeTabBeforeReplacementSync:activeTabBeforeReplacementSync.map(tab => ({id:tab.id,url:tab.url})),
        replacementShowsWebMenu,
        replacementSynchronizesPdfMenu,
        backgroundReplacementIgnored,
        backgroundReplacementUpdates,
        replacementUpdates,
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
    item.id === 'blb-suite-web-selection' || item.id === 'blb-suite-pdf-selection'
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
  expect(result.replacementSynced, JSON.stringify({
    replacementTabId:result.replacementTabId,
    activeTabBeforeReplacementSync:result.activeTabBeforeReplacementSync,
    replacementUpdates:result.replacementUpdates
  }, null, 2)).toBe(true);
  expect(result.replacementShowsWebMenu, JSON.stringify({
    replacementSynced:result.replacementSynced,
    replacementUpdates:result.replacementUpdates
  }, null, 2)).toBe(true);
  expect(result.replacementSynchronizesPdfMenu).toBe(true);
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
      isPageButtonEnabledForHostname = async hostname => {
        if (hostname === 'slow.example') {
          signalSlowStarted();
          await slowGate;
          return false;
        }
        return hostname === 'fast.example';
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

  expect(result).toEqual([{id:'blb-suite-pdf-selection',visible:true}]);
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

