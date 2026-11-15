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

    try {
      selectionMenuKnownPresent = true;
      pdfSelectionMenuKnownPresent = true;
      // This test isolates menu lifecycle behavior; host-grant UX is covered
      // separately, so make the selected fixture host eligible deterministically.
      hasSelectionActionPermissionForTab = async tab =>
        new URL(tab?.url || 'about:blank').hostname === 'example.com';
      chrome.contextMenus.update = async (id, details) => {
        updates.push({id, ...details});
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
      await new Promise(resolve => setTimeout(resolve, 100));
      updates.length = 0;

      if (!chrome.tabs.onActivated.hasListeners() || !chrome.tabs.onUpdated.hasListeners()) {
        throw new Error('Expected tab activation and update listeners to be registered');
      }

      // A real tab activation must make both global menus reflect the active tab.
      await chrome.tabs.update(enabledTab.id, {active:true});
      for (let attempt=0; attempt<50 && !updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      ); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const activationUpdates = [...updates];
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
      for (let attempt=0; attempt<50 && !updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      ); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      updates.length = 0;
      const replacementSynced = await syncSelectionMenusAfterTabReplacement(replacementTab.id);
      const replacementShowsWebMenu = updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      );
      const replacementSynchronizesPdfMenu = updates.some(item =>
        item.id === 'blb-suite-pdf-selection'
      );

      // Replacements in a background tab must not change global menu state.
      updates.length = 0;
      const backgroundReplacementIgnored = !(await syncSelectionMenusAfterTabReplacement(inactiveTab.id));
      const backgroundReplacementUpdates = [...updates];

      // Focusing a different browser window must also refresh the global menus;
      // the active tab inside either window can remain unchanged.
      const originalWindowId = replacementTab.windowId;
      const focusEvents = [];
      const recordFocusEvent = windowId => focusEvents.push(windowId);
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
      updates.length = 0;
      await chrome.windows.update(originalWindowId,{focused:true});
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
      await chrome.windows.remove(otherWindow.id);

      return {
        activationShowsWebMenu,
        activationSynchronizesPdfMenu,
        inactiveNavigationUpdates,
        activeNavigationHidesWebMenu,
        replacementSynced,
        replacementShowsWebMenu,
        replacementSynchronizesPdfMenu,
        backgroundReplacementIgnored,
        backgroundReplacementUpdates,
        focusChangeHidesWebMenu,
        focusChangeShowsWebMenu,
        focusEvents,
        originalWindowId,
        focusedWindowId
      };
    } finally {
      chrome.contextMenus.update = originalUpdate;
      selectionMenuKnownPresent = originalWebKnownPresent;
      pdfSelectionMenuKnownPresent = originalPdfKnownPresent;
      hasSelectionActionPermissionForTab = originalSelectionPermissionCheck;
      if (typeof recordFocusEvent === 'function') {
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
  expect(
    result.inactiveNavigationUpdates.filter(item =>
      item.id === 'blb-suite-web-selection' || item.id === 'blb-suite-pdf-selection'
    )
  ).toEqual([]);
  expect(result.activeNavigationHidesWebMenu).toBe(true);
  expect(result.replacementSynced).toBe(true);
  expect(result.replacementShowsWebMenu).toBe(true);
  expect(result.replacementSynchronizesPdfMenu).toBe(true);
  expect(result.backgroundReplacementIgnored).toBe(true);
  expect(result.backgroundReplacementUpdates).toEqual([]);
  expect(result.focusChangeHidesWebMenu).toBe(true);
  expect(result.focusChangeShowsWebMenu).toBe(true);
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
