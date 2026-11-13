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
  const createdTabIds = [];
  const result = await extensionWorker.evaluate(async () => {
    const originalUpdate = chrome.contextMenus.update;
    const originalWebKnownPresent = selectionMenuKnownPresent;
    const originalPdfKnownPresent = pdfSelectionMenuKnownPresent;
    const updates = [];

    try {
      selectionMenuKnownPresent = true;
      pdfSelectionMenuKnownPresent = true;
      chrome.contextMenus.update = async (id, details) => {
        updates.push({id, ...details});
      };

      const tabs = await chrome.tabs.query({active:true,currentWindow:true});
      const initialTabId = tabs[0]?.id;
      const enabledTab = await chrome.tabs.create({
        url:'https://example.com/',
        active:false
      });
      const inactiveTab = await chrome.tabs.create({
        url:'about:blank',
        active:false
      });

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

      // A real tab activation must make the global web menu reflect the newly
      // active site's explicit Show on BLB preference.
      await chrome.tabs.update(enabledTab.id, {active:true});
      for (let attempt=0; attempt<50 && !updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
      ); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const activationShowsWebMenu = updates.some(item =>
        item.id === 'blb-suite-web-selection' && item.visible === true
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

      // Navigating the active tab to a sensitive host must hide the menu.
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

      return {
        initialTabId,
        enabledTabId:enabledTab.id,
        inactiveTabId:inactiveTab.id,
        activationShowsWebMenu,
        inactiveNavigationUpdates,
        activeNavigationHidesWebMenu,
        pdfMenuUpdatedOnActivation:updates.some(item => item.id === 'blb-suite-pdf-selection')
      };
    } finally {
      chrome.contextMenus.update = originalUpdate;
      selectionMenuKnownPresent = originalWebKnownPresent;
      pdfSelectionMenuKnownPresent = originalPdfKnownPresent;
    }
  });

  createdTabIds.push(result.enabledTabId, result.inactiveTabId);
  try {
    expect(result.activationShowsWebMenu).toBe(true);
    expect(
      result.inactiveNavigationUpdates.filter(item =>
        item.id === 'blb-suite-web-selection' || item.id === 'blb-suite-pdf-selection'
      )
    ).toEqual([]);
    expect(result.activeNavigationHidesWebMenu).toBe(true);
  } finally {
    await extensionWorker.evaluate(async ({ids, settings}) => {
      await Promise.all(ids.map(id => chrome.tabs.remove(id).catch(() => {})));
      await chrome.storage.local.set(settings);
      await runtimeContentScriptReconciliationQueue;
    }, {ids:createdTabIds,settings:previous});
  }
});
