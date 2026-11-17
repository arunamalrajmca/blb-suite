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
    const recovery = extensionWorker.evaluate(id => handleReplacedTabIdentity(id, 940011), tabId);
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.started);

    // The replacement passed its initial eligibility check, but the user turns
    // the feature OFF before the actual tab activation begins.
    await extensionStorage.set({pageSelectionButtonSites:{'example.com':false}});
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.release());
    await recovery;

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
    const recovery = extensionWorker.evaluate(id => handleReplacedTabIdentity(id, 940012), tabId);
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.started);

    await page.close();
    await extensionWorker.evaluate(() => globalThis.__replacementActivationGate.release());
    await recovery;

    expect(await extensionWorker.evaluate(() => globalThis.__replacementActivationResult)).toBe(false);
  } finally {
    await cleanupReplacementActivationGate(extensionWorker, extensionStorage, page);
  }
});
