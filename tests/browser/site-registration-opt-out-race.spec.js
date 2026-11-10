const { test, expect } = require('./fixtures');

test('rapid site opt-out waits for an older registration reconciliation before unregistering', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    const key = 'example.com';
    const url = 'https://example.com/';
    const pattern = originPatternForUrl(url);
    const id = runtimeContentScriptIdForPattern(pattern);
    const previous = await chrome.storage.local.get({
      masterEnabled:true,
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{},
      redirectEnabled:false
    });
    const originalGet = chrome.scripting.getRegisteredContentScripts;
    let firstInspectionStarted;
    const inspectionStarted = new Promise(resolve => { firstInspectionStarted = resolve; });
    let releaseFirstInspection;
    const firstInspectionGate = new Promise(resolve => { releaseFirstInspection = resolve; });
    let inspectionCalls = 0;
    const wrappedGet = async (...args) => {
      inspectionCalls++;
      if (inspectionCalls === 1) {
        firstInspectionStarted();
        await firstInspectionGate;
      }
      return originalGet.apply(chrome.scripting, args);
    };

    try {
      await chrome.scripting.unregisterContentScripts({ids:[id]}).catch(() => {});
      await chrome.storage.local.set({
        masterEnabled:true,
        redirectEnabled:false,
        pageSelectionButtonSites:{...previous.pageSelectionButtonSites,[key]:true},
        doubleClickBlbSites:previous.doubleClickBlbSites
      });
      // Drain the storage.onChanged reconciliation caused by setup before
      // instrumenting the deliberately delayed ON pass below.
      await reconcileRuntimeContentScriptRegistrations();
      await runtimeContentScriptReconciliationQueue;
      // Keep the enabled registration in place so the delayed older pass
      // snapshots it before the opt-out arrives, then tries to retain it.
      chrome.scripting.getRegisteredContentScripts = wrappedGet;
      const olderEnabledPass = reconcileRuntimeContentScriptRegistrations();
      await inspectionStarted;

      await chrome.storage.local.set({
        pageSelectionButtonSites:{...previous.pageSelectionButtonSites,[key]:false}
      });
      const newerOptOutPass = reconcileRuntimeContentScriptRegistrations();
      await new Promise(resolve => setTimeout(resolve, 50));
      const callsBeforeRelease = inspectionCalls;

      releaseFirstInspection();
      await Promise.all([olderEnabledPass, newerOptOutPass]);
      const remaining = await originalGet.call(chrome.scripting, {ids:[id]});
      return {callsBeforeRelease, registrationRemains:remaining.length > 0};
    } finally {
      releaseFirstInspection?.();
      chrome.scripting.getRegisteredContentScripts = originalGet;
      await chrome.scripting.unregisterContentScripts({ids:[id]}).catch(() => {});
      await chrome.storage.local.set({
        masterEnabled:previous.masterEnabled,
        redirectEnabled:previous.redirectEnabled,
        pageSelectionButtonSites:previous.pageSelectionButtonSites,
        doubleClickBlbSites:previous.doubleClickBlbSites
      });
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
    }
  });

  expect(result.callsBeforeRelease).toBe(1);
  expect(result.registrationRemains).toBe(false);
});
