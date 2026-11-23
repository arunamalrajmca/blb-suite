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
    await page.route('https://christianity.com/**',route=>route.fulfill({
      status:200,contentType:'text/html',
      body:'<!doctype html><html><head><title>Stale activation regression</title></head><body><main>Article</main></body></html>'
    }));
    await page.goto(sourceUrl,{waitUntil:'domcontentloaded'});

    const tabId = await extensionWorker.evaluate(async url => {
      const tabs = await chrome.tabs.query({url});
      if (!tabs.length) throw new Error('Could not locate the regression tab');
      return tabs[0].id;
    },sourceUrl);

    // Prime the tab with a fully initialized content script before holding the
    // next activation handshake. This distinguishes handshake reuse from the
    // expected first-time fallback injection on a page with no receiver yet.
    const primed = await extensionWorker.evaluate(async id => ensureContentScriptInTab(id),tabId);
    expect(primed).toBe(true);
    const handshakeReady = async () => extensionWorker.evaluate(async id => {
      const [result] = await chrome.scripting.executeScript({
        target:{tabId:id},world:'ISOLATED',
        func:() => window.__blbSuiteRefreshHandshakeReadyV1 === true
      });
      return result?.result === true;
    },tabId);
    await expect.poll(handshakeReady,{timeout:15000}).toBe(true);

    await extensionWorker.evaluate(id => {
      let resolveStarted;
      let resolveRelease;
      let resolveRecoveryAttempt;
      const started = new Promise(resolve=>{resolveStarted=resolve;});
      const release = new Promise(resolve=>{resolveRelease=resolve;});
      const recoveryAttempt = new Promise(resolve=>{resolveRecoveryAttempt=resolve;});
      const originalSendMessage = chrome.tabs.sendMessage;
      const originalExecuteScript = chrome.scripting.executeScript;
      const originalEnsure = ensureContentScriptInTab;
      const gate = {
        started,release,recoveryAttempt,resolveRelease,resolveRecoveryAttempt,
        originalSendMessage,originalExecuteScript,originalEnsure,
        blocked:false,released:false,response:null,targetTabId:id,
        fallbackInjectionCalls:0,recoverySawExistingLock:false
      };
      chrome.scripting.executeScript = async function(details,...args) {
        if (details?.target?.tabId === gate.targetTabId &&
            Array.isArray(details?.files) && details.files.includes('content.js')) gate.fallbackInjectionCalls++;
        return originalExecuteScript.call(this,details,...args);
      };
      chrome.tabs.sendMessage = async function(targetId,message,...args) {
        if (targetId === gate.targetTabId && message?.type === 'blbSuiteRefreshSiteFeatures' && !gate.released) {
          if (!gate.blocked) {
            gate.blocked = true;
            resolveStarted();
          }
          await release;
        }
        const response = await originalSendMessage.call(this,targetId,message,...args);
        if (targetId === gate.targetTabId && message?.type === 'blbSuiteRefreshSiteFeatures') gate.response = response;
        return response;
      };
      globalThis.ensureContentScriptInTab = async function(targetId,...args) {
        if (targetId === gate.targetTabId && gate.blocked && !gate.released) {
          gate.recoverySawExistingLock = contentScriptInjectionLocks.has(targetId);
          resolveRecoveryAttempt();
        }
        return originalEnsure.call(this,targetId,...args);
      };
      globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__ = gate;
      gate.activationPromise = ensureContentScriptInTab(id);
    },tabId);
    gateInstalled = true;

    await extensionWorker.evaluate(() => globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__.started);
    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:true,mainWorld:true});
    const fallbackInjectionCallsBeforeRecovery = await extensionWorker.evaluate(() =>
      globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__?.fallbackInjectionCalls
    );
    expect(fallbackInjectionCallsBeforeRecovery).toBe(0);

    // OFF removes both registrations while the new activation remains held.
    await extensionStorage.set({masterEnabled:false});
    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:false,mainWorld:false});

    // ON must enter ensureContentScriptInTab while the older activation is
    // still in flight; only then release the held handshake.
    await extensionStorage.set({masterEnabled:true});
    await extensionWorker.evaluate(() => globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__.recoveryAttempt);
    const recoverySawExistingLock = await extensionWorker.evaluate(() =>
      globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__?.recoverySawExistingLock
    );
    expect(recoverySawExistingLock).toBe(true);

    await extensionWorker.evaluate(() => {
      const gate = globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__;
      gate.released = true;
      gate.resolveRelease();
    });
    await expect.poll(readRegistrations,{timeout:15000}).toEqual({isolated:true,mainWorld:true});
    await expect.poll(async () => extensionWorker.evaluate(() =>
      globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__?.response
    ),{timeout:15000}).toEqual({ok:true});
    const fallbackInjectionCalls = await extensionWorker.evaluate(() =>
      globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__?.fallbackInjectionCalls
    );
    expect(fallbackInjectionCalls).toBe(fallbackInjectionCallsBeforeRecovery);
    await extensionWorker.evaluate(async () => {
      await globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__.activationPromise;
    });
  } finally {
    if (gateInstalled) {
      await extensionWorker.evaluate(() => {
        const gate = globalThis.__BLB_MASTER_TOGGLE_ACTIVATION_GATE__;
        if (gate) {
          gate.released = true;
          gate.resolveRelease();
          chrome.tabs.sendMessage = gate.originalSendMessage;
          chrome.scripting.executeScript = gate.originalExecuteScript;
          globalThis.ensureContentScriptInTab = gate.originalEnsure;
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


test('a failed in-flight activation does not suppress a fresh eligible current-tab fallback', async ({
  page, extensionWorker, extensionStorage
}) => {
  const previous = await extensionWorker.evaluate(async () => chrome.storage.local.get({
    masterEnabled:true,redirectEnabled:false,pageSelectionButtonSites:{},doubleClickBlbSites:{}
  }));
  try {
    await extensionStorage.set({
      masterEnabled:true,redirectEnabled:false,
      pageSelectionButtonSites:{'example.com':true},doubleClickBlbSites:{}
    });
    await page.goto('https://example.com/__blb-suite-regression__/failed-inflight-fallback', {
      waitUntil:'domcontentloaded'
    });
    const tabId = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      return tabs[0]?.id ?? null;
    });
    expect(Number.isInteger(tabId)).toBe(true);
    const primed = await extensionWorker.evaluate(async id => ensureContentScriptInTab(id),tabId);
    expect(primed).toBe(true);

    const activated = await extensionWorker.evaluate(async id => {
      const pattern = 'https://example.com/*';
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      const ids = scripts.filter(script => (script.matches || []).includes(pattern) &&
        String(script.id || '').startsWith('blb-suite-runtime-')).map(script => script.id);
      if (ids.length) await chrome.scripting.unregisterContentScripts({ids});
      const failedActivation = Promise.resolve(false);
      const originalRegister = chrome.scripting.registerContentScripts;
      contentScriptInjectionLocks.set(id,failedActivation);
      chrome.scripting.registerContentScripts = async () => {
        throw new Error('Simulated persistent registration failure after stale activation');
      };
      try {
        return await ensureContentScriptInTab(id);
      } finally {
        chrome.scripting.registerContentScripts = originalRegister;
        if (contentScriptInjectionLocks.get(id) === failedActivation) {
          contentScriptInjectionLocks.delete(id);
        }
      }
    },tabId);
    expect(activated).toBe(true);
  } finally {
    await extensionStorage.set({
      masterEnabled:previous.masterEnabled,
      redirectEnabled:previous.redirectEnabled,
      pageSelectionButtonSites:previous.pageSelectionButtonSites,
      doubleClickBlbSites:previous.doubleClickBlbSites
    }).catch(()=>{});
  }
});
