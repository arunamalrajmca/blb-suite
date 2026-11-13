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
    const createdTabIds = [];
    const updates = [];

    try {
      selectionMenuKnownPresent = true;
      pdfSelectionMenuKnownPresent = true;
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

      return {
        activationShowsWebMenu,
        activationSynchronizesPdfMenu,
        inactiveNavigationUpdates,
        activeNavigationHidesWebMenu
      };
    } finally {
      chrome.contextMenus.update = originalUpdate;
      selectionMenuKnownPresent = originalWebKnownPresent;
      pdfSelectionMenuKnownPresent = originalPdfKnownPresent;
      await Promise.all(createdTabIds.map(id => chrome.tabs.remove(id).catch(() => {})));
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
});
