const { test, expect } = require('./fixtures');

test('host-access revocation removes registrations and a later grant reactivates the preserved opt-in', async ({
  page, extensionWorker, extensionStorage
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(async () => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false
  }));

  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{},
      redirectEnabled:false
    });
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});

    const tabId = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
    );
    expect(Number.isInteger(tabId)).toBe(true);

    const registrationId = await extensionWorker.evaluate(value =>
      runtimeContentScriptIdForPattern(value), pattern
    );
    const registrationExists = () => extensionWorker.evaluate(async id =>
      (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length > 0,
      registrationId
    );

    const injected = await extensionWorker.evaluate(id => ensureContentScriptInTab(id), tabId);
    expect(injected).toBe(true);
    await expect.poll(registrationExists, {timeout:10000}).toBe(true);

    const revocationListenerPresent = await extensionWorker.evaluate(() =>
      chrome.permissions.onRemoved.hasListeners()
    );
    expect(revocationListenerPresent).toBe(true);
    const grantListenerPresent = await extensionWorker.evaluate(() =>
      chrome.permissions.onAdded.hasListeners()
    );
    expect(grantListenerPresent).toBe(true);

    // Headless Chromium cannot accept Chrome's native optional-permission
    // prompt. Simulate the post-revocation permission lookup at the API
    // boundary, then exercise the same serialized registration reconciler
    // that the onRemoved listener invokes.
    await extensionWorker.evaluate(async originPattern => {
      const originalContains = chrome.permissions.contains;
      chrome.permissions.contains = async details =>
        details?.origins?.includes(originPattern)
          ? false
          : originalContains(details);
      try {
        await reconcileRuntimeContentScriptRegistrations();
      } finally {
        chrome.permissions.contains = originalContains;
      }
    }, pattern);

    await expect.poll(registrationExists, {timeout:10000}).toBe(false);

    const storedPreference = await extensionWorker.evaluate(async () => {
      const data = await chrome.storage.local.get({pageSelectionButtonSites:{}});
      return data.pageSelectionButtonSites['example.com'];
    });
    expect(storedPreference).toBe(true);

    // Simulate Chrome's onAdded handler after access is restored. The original
    // permission API is back in place, so the retained opt-in should register
    // the content script again for the already-open tab.
    await extensionWorker.evaluate(pattern =>
      injectEnabledTabsForGrantedOrigins([pattern]), pattern
    );
    await expect.poll(registrationExists, {timeout:10000}).toBe(true);
  } finally {
    await extensionWorker.evaluate(async ({originPattern,settings}) => {
      const id=runtimeContentScriptIdForPattern(originPattern);
      await chrome.scripting.unregisterContentScripts({ids:[id,id+'-main-world']}).catch(() => {});
      await chrome.storage.local.set(settings);
    }, {originPattern:pattern,settings:previous});
  }
});
