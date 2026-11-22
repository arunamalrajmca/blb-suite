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


test('master OFF-to-ON recovery repairs registrations after an older tab activation finishes', async ({
  page, extensionWorker, extensionStorage
}) => {
  const sourceUrl = 'https://christianity.com/__blb-suite-regression__/stale-activation';
  const originPattern = 'https://christianity.com/*';
  const previous = await extensionWorker.evaluate(async () => chrome.storage.local.get({
    masterEnabled:true,redirectEnabled:false,pageSelectionButtonSites:{},doubleClickBlbSites:{}
  }));
  let gateInstalled = false;

  const readRegistrations = () => extensionWorker.evaluate(async pattern => {
    const id = runtimeContentScriptIdForPattern(pattern);
    const scripts = await chrome.scripting.getRegisteredContentScripts({ids:[id,id+'-main-world']});
    return {
      isolated:scripts.some(script=>script.id===id),
      mainWorld:scripts.some(script=>script.id===id+'-main-world')
    };
  },originPattern);

  try {
    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{}
    });

    await extensionWorker.evaluate(() => {
      let resolveStarted;
      let resolveRelease;
      const started = new Promise(resolve=>{resolveStarted=resolve;});
      const release = new Promise(resolve=>{resolveRelease=resolve;});
      const original = chrome.tabs.sendMessage;
      const gate = {started,release,resolveRelease,original,blocked:false};
      globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__ = gate;
      chrome.tabs.sendMessage = async function(tabId,message,...args) {
        if (!gate.blocked && message?.type === 'blbSuiteRefreshSiteFeatures') {
          let tab = null;
          try { tab = await chrome.tabs.get(tabId); } catch (_) {}
          if (String(tab?.url || '').startsWith('https://christianity.com/')) {
            gate.blocked = true;
            resolveStarted();
            await release;
          }
        }
        return original.call(this,tabId,message,...args);
      };
      if (chrome.tabs.sendMessage === original) {
        throw new Error('Could not install the deterministic content-script handshake gate');
      }
    });
    gateInstalled = true;

    await page.route('https://christianity.com/**',route=>route.fulfill({
      status:200,contentType:'text/html',
      body:'<!doctype html><html><head><title>Stale activation regression</title></head><body><main>Article</main></body></html>'
    }));
    await page.goto(sourceUrl,{waitUntil:'domcontentloaded'});

    // The initial activation registers both worlds before it reaches the
    // deliberately held refresh handshake. Keep that activation in flight.
    await extensionWorker.evaluate(async () => {
      await globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__.started;
    });
    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:true,mainWorld:true});

    // OFF removes both registrations while the original activation is still
    // holding the per-tab in-flight promise.
    await extensionStorage.set({masterEnabled:false});
    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:false,mainWorld:false});

    // ON recovery encounters the older activation promise. Release it only
    // after the new setting is committed so recovery must repair stale state.
    await extensionStorage.set({masterEnabled:true});
    await extensionWorker.evaluate(() => {
      globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__.resolveRelease();
    });

    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:true,mainWorld:true});
  } finally {
    if (gateInstalled) {
      await extensionWorker.evaluate(() => {
        const gate = globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__;
        if (gate) {
          gate.resolveRelease();
          chrome.tabs.sendMessage = gate.original;
          delete globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__;
        }
      }).catch(()=>{});
    }
    await extensionStorage.set({
      masterEnabled:previous.masterEnabled,
      redirectEnabled:previous.redirectEnabled,
      pageSelectionButtonSites:previous.pageSelectionButtonSites,
      doubleClickBlbSites:previous.doubleClickBlbSites
    }).catch(()=>{});
  }
});
