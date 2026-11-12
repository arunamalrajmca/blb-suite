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
test('current-tab activation falls back when persistent content-script registration fails', async ({ page, extensionStorage, extensionWorker }) => {
  // Load the tab before enabling the feature so the normal onUpdated path
  // cannot race this test's deliberately failed registration.
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{},
    redirectEnabled:false
  });

  const activated = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({url:'https://example.com/*'});
    const tab = tabs[0];
    if (!tab?.id) throw new Error('Expected the example.com test tab to exist');
    // Let any settings-change activation started by the fixture settle first.
    const pendingActivation = contentScriptInjectionLocks.get(tab.id);
    if (pendingActivation) await pendingActivation.catch(() => {});
    const pattern = originPatternForUrl(tab.url);
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const matchingIds = registered
      .filter(entry => entry.matches?.includes(pattern) && entry.id.startsWith('blb-suite-runtime-'))
      .map(entry => entry.id);
    if (matchingIds.length) {
      await chrome.scripting.unregisterContentScripts({ids:matchingIds});
    }
    const remaining = (await chrome.scripting.getRegisteredContentScripts())
      .filter(entry => entry.matches?.includes(pattern) && entry.id.startsWith('blb-suite-runtime-'));
    if (remaining.length) {
      throw new Error('Could not remove existing example.com registrations: ' + remaining.map(entry => entry.id).join(', '));
    }
    const originalRegister = chrome.scripting.registerContentScripts;
    const failingRegister = async () => {
      throw new Error('Simulated persistent registration failure');
    };
    chrome.scripting.registerContentScripts = failingRegister;
    if (chrome.scripting.registerContentScripts !== failingRegister) {
      chrome.scripting.registerContentScripts = originalRegister;
      throw new Error('Unable to instrument registerContentScripts for activation-failure test');
    }
    try {
      return await ensureContentScriptInTab(tab.id);
    } finally {
      chrome.scripting.registerContentScripts = originalRegister;
    }
  });

  expect(activated).toBe(true);
});

test('a stale redirect-rule update cannot finish after a newer OFF update', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    const originalGet = chrome.storage.local.get;
    const originalUpdate = chrome.declarativeNetRequest.updateDynamicRules;
    const updates = [];
    let readCount = 0;
    let releaseFirstRead;
    let signalFirstRead;
    const firstReadStarted = new Promise(resolve => { signalFirstRead = resolve; });

    chrome.storage.local.get = async defaults => {
      if (defaults && Object.prototype.hasOwnProperty.call(defaults, 'redirectEnabled') &&
          Object.prototype.hasOwnProperty.call(defaults, 'masterEnabled')) {
        readCount++;
        if (readCount === 1) {
          signalFirstRead();
          return await new Promise(resolve => { releaseFirstRead = resolve; });
        }
        return {redirectEnabled:false, masterEnabled:true};
      }
      return originalGet.call(chrome.storage.local, defaults);
    };
    chrome.declarativeNetRequest.updateDynamicRules = async details => {
      updates.push({addRuleCount:details.addRules.length, removeRuleIds:[...details.removeRuleIds]});
    };

    try {
      const olderOn = installRules();
      await firstReadStarted;
      const newerOff = installRules();
      releaseFirstRead({redirectEnabled:true, masterEnabled:true});
      await Promise.all([olderOn, newerOff]);
      return {updates, finalAddRuleCount:updates.at(-1)?.addRuleCount ?? null};
    } finally {
      chrome.storage.local.get = originalGet;
      chrome.declarativeNetRequest.updateDynamicRules = originalUpdate;
    }
  });

  expect(result.updates.length).toBe(2);
  expect(result.finalAddRuleCount).toBe(0);
});
