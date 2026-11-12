const { test, expect } = require('./fixtures');

const SITE = 'example.com';

async function preparePopup(page, extensionId, extensionStorage, extensionWorker, {
  pageButton,
  doubleClick,
  permission = true
} = {}) {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: pageButton === undefined ? {} : { [SITE]: pageButton },
    doubleClickBlbSites: doubleClick === undefined ? {} : { [SITE]: doubleClick },
    pendingSiteFeatureToggles: {}
  });

  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body =>
    !body.classList.contains('popup-loading')
  )).toBe(true);
  await page.evaluate(async permissionResult => {
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    Object.defineProperty(chrome.tabs, 'query', {
      configurable: true,
      value: async queryInfo => queryInfo?.active
        ? [{ id: 987654, url: 'https://example.com/', title: 'Example' }]
        : originalQuery(queryInfo)
    });
    Object.defineProperty(chrome.permissions, 'request', {
      configurable: true,
      value: async () => permissionResult
    });
    render(await getState());
  }, permission);
  // The checkbox inputs are intentionally visually hidden; interact with
  // their visible switch surfaces, matching the real popup UI.
  await expect(page.locator('#pageSetting')).toBeVisible();
  await expect(page.locator('#doubleSetting')).toBeVisible();
  await expect(page.locator('#pageButton')).toBeEnabled();
  await expect(page.locator('#doubleClick')).toBeEnabled();

  const stored = await extensionWorker.evaluate(() => chrome.storage.local.get({
    pageSelectionButtonSites: {},
    doubleClickBlbSites: {}
  }));
  expect(stored.pageSelectionButtonSites[SITE]).toBe(pageButton);
  expect(stored.doubleClickBlbSites[SITE]).toBe(doubleClick);
}

async function readSitePreferences(extensionWorker) {
  return extensionWorker.evaluate(() => chrome.storage.local.get({
    pageSelectionButtonSites: {},
    doubleClickBlbSites: {},
    pendingSiteFeatureToggles: {}
  }));
}

for (const otherState of ['on', 'off', 'unset']) {
  test(`popup Show on grant preserves Double-click when its prior state is ${otherState}`, async ({
    page, extensionId, extensionStorage, extensionWorker
  }) => {
    const doubleClick = otherState === 'on' ? true : otherState === 'off' ? false : undefined;
    await preparePopup(page, extensionId, extensionStorage, extensionWorker, {
      pageButton: false,
      doubleClick
    });

    await page.locator('#pageSetting .slider').click();
    await expect.poll(async () => readSitePreferences(extensionWorker)).toMatchObject({
      pageSelectionButtonSites: { [SITE]: true },
      doubleClickBlbSites: doubleClick === undefined ? {} : { [SITE]: doubleClick }
    });
    const stored = await readSitePreferences(extensionWorker);
    expect(Object.hasOwn(stored.doubleClickBlbSites, SITE)).toBe(doubleClick !== undefined);
    expect(stored.doubleClickBlbSites[SITE]).toBe(doubleClick);
  });

  test(`popup Double-click grant preserves Show on when its prior state is ${otherState}`, async ({
    page, extensionId, extensionStorage, extensionWorker
  }) => {
    const pageButton = otherState === 'on' ? true : otherState === 'off' ? false : undefined;
    await preparePopup(page, extensionId, extensionStorage, extensionWorker, {
      pageButton,
      doubleClick: false
    });

    await page.locator('#doubleSetting .slider').click();
    await expect.poll(async () => readSitePreferences(extensionWorker)).toMatchObject({
      doubleClickBlbSites: { [SITE]: true },
      pageSelectionButtonSites: pageButton === undefined ? {} : { [SITE]: pageButton }
    });
    const stored = await readSitePreferences(extensionWorker);
    expect(Object.hasOwn(stored.pageSelectionButtonSites, SITE)).toBe(pageButton !== undefined);
    expect(stored.pageSelectionButtonSites[SITE]).toBe(pageButton);
  });
}

for (const feature of ['pageButton', 'doubleClick']) {
  test(`denying the popup ${feature} permission leaves the other site feature unchanged`, async ({
    page, extensionId, extensionStorage, extensionWorker
  }) => {
    await preparePopup(page, extensionId, extensionStorage, extensionWorker, {
      pageButton: feature === 'doubleClick',
      doubleClick: feature === 'pageButton',
      permission: false
    });

    await page.locator(`#${feature}`).check();
    await expect.poll(async () => readSitePreferences(extensionWorker)).toMatchObject({
      pageSelectionButtonSites: { [SITE]: feature === 'doubleClick' },
      doubleClickBlbSites: { [SITE]: feature === 'pageButton' },
      pendingSiteFeatureToggles: {}
    });
  });
}

for (const feature of ['pageButton', 'doubleClick']) {
  test(`closing the popup during the ${feature} permission request preserves only that pending choice`, async ({
    page, extensionId, extensionStorage, extensionWorker
  }) => {
    await extensionStorage.set({
      masterEnabled: true,
      pageSelectionButtonSites: { [SITE]: feature === 'doubleClick' },
      doubleClickBlbSites: { [SITE]: feature === 'pageButton' },
      pendingSiteFeatureToggles: {}
    });

    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect.poll(() => page.locator('body').evaluate(body =>
      !body.classList.contains('popup-loading')
    )).toBe(true);
    await page.evaluate(async () => {
      const originalQuery = chrome.tabs.query.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, 'query', {
        configurable: true,
        value: async queryInfo => queryInfo?.active
          ? [{ id: 987654, url: 'https://example.com/', title: 'Example' }]
          : originalQuery(queryInfo)
      });
      window.__sitePermissionRequested = false;
      Object.defineProperty(chrome.permissions, 'request', {
        configurable: true,
        value: () => new Promise(() => {
          window.__sitePermissionRequested = true;
        })
      });
      render(await getState());
    });
    await expect(page.locator(feature === 'pageButton' ? '#pageSetting' : '#doubleSetting')).toBeVisible();
    await page.locator(feature === 'pageButton' ? '#pageSetting .slider' : '#doubleSetting .slider').click();
    await expect.poll(() => page.evaluate(() => window.__sitePermissionRequested)).toBe(true);

    await expect.poll(async () => readSitePreferences(extensionWorker)).toMatchObject({
      pendingSiteFeatureToggles: {
        'https://example.com/*': { feature }
      }
    });
    await page.close();

    const beforeGrant = await readSitePreferences(extensionWorker);
    expect(beforeGrant.pageSelectionButtonSites[SITE]).toBe(feature === 'doubleClick');
    expect(beforeGrant.doubleClickBlbSites[SITE]).toBe(feature === 'pageButton');

    const committed = await extensionWorker.evaluate(() =>
      commitPendingSiteFeatureTogglesForGrantedOrigins(['https://example.com/*'])
    );
    expect(committed.committed).toEqual([{ origin: 'https://example.com/*', feature }]);

    const afterGrant = await readSitePreferences(extensionWorker);
    expect(afterGrant.pageSelectionButtonSites[SITE]).toBe(true);
    expect(afterGrant.doubleClickBlbSites[SITE]).toBe(true);
    expect(afterGrant.pendingSiteFeatureToggles).toEqual({});
  });
}
