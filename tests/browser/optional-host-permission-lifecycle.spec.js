const { test, expect } = require('./fixtures');

test('background extension-page messages reject content scripts and bind the MultiVerse queue to its owner page', async ({
  context,
  extensionId,
  extensionWorker
}) => {
  const sourcePage = await context.newPage();
  await sourcePage.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body>sender authorization fixture</body></html>'
  }));
  await sourcePage.goto('https://example.com/');

  const sourceTabId = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => (tab.url || '').startsWith('https://example.com/'))?.id ?? null;
  });
  expect(sourceTabId).not.toBeNull();

  const contentScriptResponses = await extensionWorker.evaluate(async tabId => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async () => ({
        studyMutation: await chrome.runtime.sendMessage({ type: 'blbSuiteClearStudy' }),
        classification: await chrome.runtime.sendMessage({
          type: 'blbSuiteClassifySelection',
          text: 'John 3:16'
        }),
        queueSlot: await chrome.runtime.sendMessage({ type: 'blbSuiteAcquireMultiVersePostSlot' }),
        studyRestore: await chrome.runtime.sendMessage({
          type: 'blbSuiteRestoreStudyBackup',
          study: { studySessions: [], studyTopics: [] }
        }),
        sitePreference: await chrome.runtime.sendMessage({
          type: 'blbSuiteSetSiteFeaturePreference',
          origin: 'https://example.com/*',
          feature: 'pageButton',
          enabled: true
        })
      })
    });
    return result.result;
  }, sourceTabId);
  expect(contentScriptResponses.studyMutation).toEqual({ ok: false, error: 'Unauthorized sender' });
  expect(contentScriptResponses.classification).toEqual({ ok: false, error: 'Unauthorized sender' });
  expect(contentScriptResponses.queueSlot).toEqual({ ok: false, error: 'Unauthorized sender' });
  expect(contentScriptResponses.studyRestore).toEqual({ ok: false, error: 'Unauthorized sender' });
  expect(contentScriptResponses.sitePreference).toEqual({ ok: false, error: 'Unauthorized sender' });

  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupResponse = await popupPage.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'blbSuiteGetStudyUiState' })
  );
  expect(popupResponse?.ok).toBe(true);
  const popupClassificationResponse = await popupPage.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'blbSuiteClassifySelection', text: 'John 3:16' })
  );
  expect(popupClassificationResponse?.ok).toBe(true);

  const popupQueueResponse = await popupPage.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'blbSuiteAcquireMultiVersePostSlot' })
  );
  expect(popupQueueResponse).toEqual({ ok: false, error: 'Unauthorized sender' });

  const handoffPage = await context.newPage();
  await handoffPage.goto(`chrome-extension://${extensionId}/multiverse-post.html`);
  const handoffQueueResponse = await handoffPage.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'blbSuiteAcquireMultiVersePostSlot' })
  );
  expect(handoffQueueResponse?.ok).toBe(true);
  expect(Number.isFinite(handoffQueueResponse?.submitAt)).toBe(true);
});


test('content-script Study and MultiVerse messages enforce source hosts and current host permission', async ({
  context,
  extensionWorker
}) => {
  const unrelatedPage = await context.newPage();
  let blbPage;
  try {
  await unrelatedPage.route('https://example.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body>unrelated sender fixture</body></html>'
  }));
  await unrelatedPage.goto('https://example.com/');

  const unrelatedTabId = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => (tab.url || '').startsWith('https://example.com/'))?.id ?? null;
  });
  expect(unrelatedTabId).not.toBeNull();

  const unrelatedResponses = await extensionWorker.evaluate(async tabId => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async () => ({
        pendingRefs: await chrome.runtime.sendMessage({ type: 'blbSuiteGetPendingMultiVerseRefs' }),
        studyCapture: await chrome.runtime.sendMessage({
          type: 'blbSuiteCaptureStudyRefs',
          refs: [{ book: 'John', chapter: 3, from: 16, to: 16 }]
        }),
        collectorMultiVerse: await chrome.runtime.sendMessage({
          type: 'blbSuiteOpenWebsterMultiVerse',
          refs: []
        })
      })
    });
    return injected.result;
  }, unrelatedTabId);
  expect(unrelatedResponses.pendingRefs).toEqual({ ok: false, error: 'Unauthorized sender' });
  expect(unrelatedResponses.studyCapture).toEqual({ ok: false, error: 'Unauthorized sender' });
  expect(unrelatedResponses.collectorMultiVerse).toEqual({ ok: false, error: 'Unauthorized sender' });

  const permissionRevokedResponse = await extensionWorker.evaluate(async tabId => {
    const originalContains = chrome.permissions.contains;
    chrome.permissions.contains = async () => false;
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: async () => chrome.runtime.sendMessage({
          type: 'blbSuiteOpenBackgroundUrl',
          url: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
        })
      });
      return injected.result;
    } finally {
      chrome.permissions.contains = originalContains;
    }
  }, unrelatedTabId);
  expect(permissionRevokedResponse).toEqual({ ok: false, reason: 'host-permission-revoked' });

  // A background content script must not invoke the Alt+B message path for
  // whichever unrelated tab happens to be active.
  const otherActivePage = await context.newPage();
  await otherActivePage.goto('about:blank');
  const inactiveSelectionResponse = await extensionWorker.evaluate(async tabId => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async () => chrome.runtime.sendMessage({ type: 'blbSuiteOpenCurrentSelection' })
    });
    return injected.result;
  }, unrelatedTabId);
  expect(inactiveSelectionResponse).toEqual({ ok: false, reason: 'unauthorized-sender' });
  await otherActivePage.close();

  blbPage = await context.newPage();
  await blbPage.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body><main>BLB sender fixture</main></body></html>'
  }));
  await blbPage.goto('https://www.blueletterbible.org/kjv/jhn/3/16/');

  const blbTabId = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => (tab.url || '').startsWith('https://www.blueletterbible.org/kjv/jhn/3/16/'))?.id ?? null;
  });
  expect(blbTabId).not.toBeNull();

  const allowedResponse = await extensionWorker.evaluate(async tabId => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async () => chrome.runtime.sendMessage({ type: 'blbSuiteGetPendingMultiVerseRefs' })
    });
    return injected.result;
  }, blbTabId);
  expect(allowedResponse).toEqual({ ok: true, refs: null });
  } finally {
    await blbPage?.close().catch(() => {});
    await unrelatedPage.close().catch(() => {});
  }
});

test('host-access revocation removes registrations and later grants reactivate each independently enabled site feature across open tabs', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(async () => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false
  }));

  let secondPage;
  const scenarios = [
    { label:'Show on BLB only', pageButton:true, doubleClick:false },
    { label:'Double-click only', pageButton:false, doubleClick:true },
    { label:'both features', pageButton:true, doubleClick:true }
  ];

  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{'example.com':false},
      redirectEnabled:false
    });
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
    const tabId = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
    );
    expect(Number.isInteger(tabId)).toBe(true);
    secondPage = await context.newPage();
    await secondPage.goto('https://example.com/second-host-permission-tab', {waitUntil:'domcontentloaded'});
    const secondTabId = await extensionWorker.evaluate(() =>
      chrome.tabs.query({url:'https://example.com/second-host-permission-tab'}).then(([tab]) => tab?.id)
    );
    expect(Number.isInteger(secondTabId)).toBe(true);

    const readFeatures = async id => extensionWorker.evaluate(async tabId => {
      const [result] = await chrome.scripting.executeScript({
        target:{tabId},
        world:'ISOLATED',
        func:() => ({
          floatingButtonPresent:Boolean(document.getElementById('blb-suite-page-selection-button')),
          doubleClickEnabled:typeof window.__blbSuiteDoubleClickBoundV2 === 'function'
        })
      });
      return result.result;
    }, id);

    const registrationId = await extensionWorker.evaluate(value =>
      runtimeContentScriptIdForPattern(value), pattern
    );
    const registrationExists = () => extensionWorker.evaluate(async id =>
      (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length > 0,
      registrationId
    );

    expect(await extensionWorker.evaluate(() => chrome.permissions.onRemoved.hasListeners())).toBe(true);
    expect(await extensionWorker.evaluate(() => chrome.permissions.onAdded.hasListeners())).toBe(true);

    for (const scenario of scenarios) {
      await extensionWorker.evaluate(async originPattern =>
        unregisterRuntimeContentScriptForPattern(originPattern), pattern
      );
      await extensionStorage.set({
        masterEnabled:true,
        pageSelectionButtonSites:{'example.com':scenario.pageButton},
        doubleClickBlbSites:{'example.com':scenario.doubleClick},
        redirectEnabled:false
      });

      const injected = await extensionWorker.evaluate(id => ensureContentScriptInTab(id), tabId);
      expect(injected, scenario.label + ': enabled preference must register the shared content script').toBe(true);
      await expect.poll(registrationExists, {timeout:10000}).toBe(true);

      // Headless Chromium cannot accept Chrome's native optional-permission
      // prompt. Simulate the post-revocation permission lookup at the API
      // boundary, then exercise the same serialized reconciler used by onRemoved.
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
      const preserved = await extensionWorker.evaluate(async () => chrome.storage.local.get({
        pageSelectionButtonSites:{}, doubleClickBlbSites:{}
      }));
      expect(preserved.pageSelectionButtonSites['example.com'], scenario.label + ': Show on BLB preference must survive revocation')
        .toBe(scenario.pageButton);
      expect(preserved.doubleClickBlbSites['example.com'], scenario.label + ': Double-click preference must survive revocation')
        .toBe(scenario.doubleClick);

      // Restore the permission API and exercise the same activation path used
      // by the onAdded handler for the already-open tab.
      await extensionWorker.evaluate(originPattern =>
        injectEnabledTabsForGrantedOrigins([originPattern]), pattern
      );
      await expect.poll(registrationExists, {timeout:10000}).toBe(true);
      const expectedFeatures = {
        floatingButtonPresent:scenario.pageButton,
        doubleClickEnabled:scenario.doubleClick
      };
      await expect.poll(() => readFeatures(tabId), {timeout:15000}).toEqual(expectedFeatures);
      await expect.poll(() => readFeatures(secondTabId), {timeout:15000}).toEqual(expectedFeatures);

      await extensionWorker.evaluate(async originPattern =>
        unregisterRuntimeContentScriptForPattern(originPattern), pattern
      );
    }
  } finally {
    await extensionWorker.evaluate(async ({originPattern,settings}) => {
      await unregisterRuntimeContentScriptForPattern(originPattern);
      await chrome.storage.local.set(settings);
    }, {originPattern:pattern,settings:previous});
    await secondPage?.close().catch(() => {});
  }
});
test('site-feature opt-ins are committed only when the matching pending host permission is granted', async ({
  extensionWorker, extensionStorage
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{}
  }));
  const requestedAt = Date.now();
  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{'example.com':true,'example.org':false},
      pendingSiteFeatureToggles:{
        'https://example.com/*':{feature:'pageButton',otherFeatureEnabled:true,requestedAt},
        'https://example.org/*':{feature:'doubleClick',otherFeatureEnabled:true,requestedAt}
      }
    });

    const beforeGrant = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},doubleClickBlbSites:{},pendingSiteFeatureToggles:{}
    }));
    expect(beforeGrant.pageSelectionButtonSites['example.com']).toBe(false);
    expect(beforeGrant.doubleClickBlbSites['example.org']).toBe(false);

    const unrelatedGrant = await extensionWorker.evaluate(() =>
      commitPendingSiteFeatureTogglesForGrantedOrigins(['https://unrelated.example/*'])
    );
    expect(unrelatedGrant.committed).toEqual([]);

    const pageGrant = await extensionWorker.evaluate(() =>
      commitPendingSiteFeatureTogglesForGrantedOrigins(['https://example.com/*'])
    );
    expect(pageGrant.committed).toEqual([{origin:'https://example.com/*',feature:'pageButton'}]);

    const doubleGrant = await extensionWorker.evaluate(() =>
      commitPendingSiteFeatureTogglesForGrantedOrigins(['https://example.org/*'])
    );
    expect(doubleGrant.committed).toEqual([{origin:'https://example.org/*',feature:'doubleClick'}]);

    const afterGrant = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},doubleClickBlbSites:{},pendingSiteFeatureToggles:{}
    }));
    expect(afterGrant.pageSelectionButtonSites['example.com']).toBe(true);
    expect(afterGrant.doubleClickBlbSites['example.com']).toBe(true);
    expect(afterGrant.doubleClickBlbSites['example.org']).toBe(true);
    expect(afterGrant.pageSelectionButtonSites['example.org']).toBeUndefined();
    expect(afterGrant.pendingSiteFeatureToggles).toEqual({});
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
  }
});


test('granting either site feature never changes the other feature setting', async ({ extensionWorker, extensionStorage }) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true, pageSelectionButtonSites:{}, doubleClickBlbSites:{}, pendingSiteFeatureToggles:{}
  }));
  try {
    for (const feature of ['pageButton', 'doubleClick']) {
      for (const otherState of ['on', 'off', 'unset']) {
        const hostname = `${feature}-${otherState}.example`.toLowerCase();
        const pageSites = {};
        const doubleSites = {};
        const otherKey = feature === 'pageButton' ? 'doubleClickBlbSites' : 'pageSelectionButtonSites';
        const targetKey = feature === 'pageButton' ? 'pageSelectionButtonSites' : 'doubleClickBlbSites';
        if (otherState === 'on') (feature === 'pageButton' ? doubleSites : pageSites)[hostname] = true;
        if (otherState === 'off') (feature === 'pageButton' ? doubleSites : pageSites)[hostname] = false;
        await extensionStorage.set({
          masterEnabled:true,
          pageSelectionButtonSites:pageSites,
          doubleClickBlbSites:doubleSites,
          pendingSiteFeatureToggles:{
            [`https://${hostname}/*`]:{feature,requestedAt:Date.now()}
          }
        });
        const result = await extensionWorker.evaluate(origin =>
          commitPendingSiteFeatureTogglesForGrantedOrigins([origin]),
          `https://${hostname}/*`
        );
        expect(result.committed).toHaveLength(1);
        const stored = await extensionWorker.evaluate(() => chrome.storage.local.get({
          pageSelectionButtonSites:{}, doubleClickBlbSites:{}
        }));
        expect(stored[targetKey][hostname]).toBe(true);
        if (otherState === 'unset') {
          expect(stored[otherKey][hostname]).toBeUndefined();
        } else {
          expect(stored[otherKey][hostname]).toBe(otherState === 'on');
        }
      }
    }
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
  }
});

test('a denied site-feature permission intent expires and cannot activate on a later unrelated grant', async ({
  extensionWorker, extensionStorage
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{}
  }));
  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{
        'https://example.com/*':{
          feature:'pageButton',
          otherFeatureEnabled:false,
          requestedAt:Date.now() - 5 * 60 * 1000 - 1
        }
      }
    });
    const result = await extensionWorker.evaluate(() =>
      commitPendingSiteFeatureTogglesForGrantedOrigins(['https://example.com/*'])
    );
    expect(result.committed).toEqual([]);
    expect(result.expired).toEqual(['https://example.com/*']);

    const afterGrant = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},pendingSiteFeatureToggles:{}
    }));
    expect(afterGrant.pageSelectionButtonSites['example.com']).toBe(false);
    expect(afterGrant.pendingSiteFeatureToggles).toEqual({});
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
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
    // Drain startup and fixture-triggered reconciliations before instrumenting
    // DNR. Otherwise unrelated queued installRules() calls can be mistaken
    // for the two deliberately scheduled operations below.
    await dynamicRulesUpdateQueue;
    await new Promise(resolve => setTimeout(resolve, 75));
    await dynamicRulesUpdateQueue;

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

  // The queue may also receive legitimate reconciliations from extension
  // lifecycle events, so assert the final security-relevant state rather than
  // coupling the test to an exact global update count.
  expect(result.updates.length).toBeGreaterThanOrEqual(2);
  expect(result.finalAddRuleCount).toBe(0);
});


test('global OFF remains authoritative across permission revocation, regrant, and extension-update recovery without changing either site preference', async ({
  page, extensionWorker, extensionStorage
}) => {
  const hostname = 'example.com';
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false
  }));
  try {
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
    const tabId = await extensionWorker.evaluate(async () =>
      (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
    );
    expect(Number.isInteger(tabId)).toBe(true);

    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{[hostname]:true},
      doubleClickBlbSites:{[hostname]:true}
    });
    const registered = () => extensionWorker.evaluate(async value => {
      const id = runtimeContentScriptIdForPattern(value);
      return (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length > 0;
    }, pattern);

    expect(await extensionWorker.evaluate(id => ensureContentScriptInTab(id), tabId)).toBe(true);
    await expect.poll(registered, {timeout:10000}).toBe(true);

    // Global OFF must remove the shared registration while preserving both
    // independently enabled site preferences.
    await extensionStorage.set({masterEnabled:false});
    await expect.poll(registered, {timeout:10000}).toBe(false);
    let state = await extensionWorker.evaluate(() => chrome.storage.local.get({
      masterEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{}
    }));
    expect(state).toMatchObject({
      masterEnabled:false,
      pageSelectionButtonSites:{[hostname]:true},
      doubleClickBlbSites:{[hostname]:true}
    });

    // Model Chrome's permission-revocation lookup at the API boundary and
    // execute the production reconciliation used by permissions.onRemoved.
    await extensionWorker.evaluate(async originPattern => {
      const contains = chrome.permissions.contains;
      chrome.permissions.contains = async details =>
        details?.origins?.includes(originPattern) ? false : contains(details);
      try {
        await reconcileRuntimeContentScriptRegistrations();
      } finally {
        chrome.permissions.contains = contains;
      }
    }, pattern);
    await expect.poll(registered, {timeout:10000}).toBe(false);

    // Regrant while master OFF: both direct grant activation and extension
    // update recovery must remain blocked by the global gate.
    await extensionWorker.evaluate(originPattern =>
      injectEnabledTabsForGrantedOrigins([originPattern]), pattern
    );
    const offRecovery = await extensionWorker.evaluate(() =>
      injectConfiguredTabsAfterExtensionUpdate()
    );
    expect(offRecovery).toEqual({
      eligibleTabIds:[],
      activatedTabIds:[],
      failedTabIds:[]
    });
    await expect.poll(registered, {timeout:5000}).toBe(false);

    // Restoring master ON must reactivate the already-authorized tab without
    // changing either preference or requiring the user to toggle a feature.
    await extensionStorage.set({masterEnabled:true});
    const recovered = await extensionWorker.evaluate(() =>
      injectConfiguredTabsAfterExtensionUpdate()
    );
    expect(recovered.eligibleTabIds).toContain(tabId);
    expect(recovered.activatedTabIds).toContain(tabId);
    await expect.poll(registered, {timeout:10000}).toBe(true);

    state = await extensionWorker.evaluate(() => chrome.storage.local.get({
      masterEnabled:false,pageSelectionButtonSites:{},doubleClickBlbSites:{}
    }));
    expect(state).toMatchObject({
      masterEnabled:true,
      pageSelectionButtonSites:{[hostname]:true},
      doubleClickBlbSites:{[hostname]:true}
    });
  } finally {
    await extensionWorker.evaluate(async ({originPattern,settings}) => {
      await unregisterRuntimeContentScriptForPattern(originPattern);
      await chrome.storage.local.set(settings);
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
    }, {originPattern:pattern,settings:previous});
  }
});


test('sensitive-site restrictions and explicit site opt-outs survive permission regrant and extension-update recovery', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  const optOutUrl = 'https://example.com/';
  const sensitiveUrl = 'https://www.gov.scot/';
  const optOutPattern = 'https://example.com/*';
  const sensitivePattern = 'https://www.gov.scot/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false
  }));
  let sensitivePage;
  try {
    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{'example.com':false,'gov.scot':true},
      doubleClickBlbSites:{'example.com':false,'gov.scot':true}
    });

    await page.goto(optOutUrl, {waitUntil:'domcontentloaded'});
    const optOutTabId = await extensionWorker.evaluate(async url =>
      (await chrome.tabs.query({url}))[0]?.id
    , optOutUrl);
    expect(Number.isInteger(optOutTabId)).toBe(true);

    sensitivePage = await context.newPage();
    await sensitivePage.route('https://www.gov.scot/**', route => route.fulfill({
      status:200,
      contentType:'text/html',
      body:'<!doctype html><html><head><title>Government test</title></head><body><p>John 3:16</p></body></html>'
    }));
    await sensitivePage.goto(sensitiveUrl, {waitUntil:'domcontentloaded'});
    const sensitiveTabId = await extensionWorker.evaluate(async url =>
      (await chrome.tabs.query({url}))[0]?.id
    , sensitiveUrl);
    expect(Number.isInteger(sensitiveTabId)).toBe(true);

    const registrationExists = pattern => extensionWorker.evaluate(async value => {
      const id = runtimeContentScriptIdForPattern(value);
      return (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length > 0;
    }, pattern);

    // Seed registrations as if they were persisted by an earlier extension
    // version before the site was opted out or classified as sensitive.
    // This deliberately bypasses today's eligibility gates so reconciliation
    // must clean up stale registrations rather than merely avoid new ones.
    await extensionWorker.evaluate(async ({optOut, sensitive}) => {
      // Recreate registrations persisted by an older extension version.
      // Use the Chrome API directly: the current production helper correctly
      // refuses to register sites that are opted out or sensitive.
      for (const url of [optOut, sensitive]) {
        const pattern = originPatternForUrl(url);
        const id = runtimeContentScriptIdForPattern(pattern);
        await chrome.scripting.registerContentScripts([{
          id,
          matches:[pattern],
          js:['content.js'],
          runAt:'document_start',
          persistAcrossSessions:true
        }]);
      }
    }, {optOut:optOutUrl,sensitive:sensitiveUrl});
    await expect.poll(() => registrationExists(optOutPattern)).toBe(true);
    await expect.poll(() => registrationExists(sensitivePattern)).toBe(true);

    // Model both permissions as granted while reconciliation runs. The
    // sensitive-site and explicit opt-out policy must still remove the stale
    // registrations independently of host permission availability.
    await extensionWorker.evaluate(async patterns => {
      const originalContains = chrome.permissions.contains;
      chrome.permissions.contains = async details =>
        details?.origins?.some(origin => patterns.includes(origin))
          ? true
          : originalContains(details);
      try {
        await reconcileRuntimeContentScriptRegistrations();
      } finally {
        chrome.permissions.contains = originalContains;
      }
    }, [optOutPattern,sensitivePattern]);

    await expect.poll(() => registrationExists(optOutPattern)).toBe(false);
    await expect.poll(() => registrationExists(sensitivePattern)).toBe(false);

    // Exercise the same activation callbacks used after a permission regrant
    // and extension update. Neither path may recreate either registration.
    await extensionWorker.evaluate(patterns =>
      injectEnabledTabsForGrantedOrigins(patterns), [optOutPattern,sensitivePattern]
    );
    const recovered = await extensionWorker.evaluate(() =>
      injectConfiguredTabsAfterExtensionUpdate()
    );
    expect(recovered.eligibleTabIds).not.toContain(optOutTabId);
    expect(recovered.eligibleTabIds).not.toContain(sensitiveTabId);
    expect(recovered.activatedTabIds).not.toContain(optOutTabId);
    expect(recovered.activatedTabIds).not.toContain(sensitiveTabId);
    expect(await extensionWorker.evaluate(id => ensureContentScriptInTab(id), optOutTabId)).toBe(false);
    expect(await extensionWorker.evaluate(id => ensureContentScriptInTab(id), sensitiveTabId)).toBe(false);
    await expect.poll(() => registrationExists(optOutPattern)).toBe(false);
    await expect.poll(() => registrationExists(sensitivePattern)).toBe(false);

    const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},doubleClickBlbSites:{}
    }));
    expect(saved.pageSelectionButtonSites).toMatchObject({'example.com':false,'gov.scot':true});
    expect(saved.doubleClickBlbSites).toMatchObject({'example.com':false,'gov.scot':true});
  } finally {
    await extensionWorker.evaluate(async ({patterns,settings}) => {
      for (const pattern of patterns) {
        await unregisterRuntimeContentScriptForPattern(pattern);
      }
      await chrome.storage.local.set(settings);
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
    }, {patterns:[optOutPattern,sensitivePattern],settings:previous});
    if (sensitivePage) await sensitivePage.close().catch(() => {});
  }
});


test('a pending permission grant cannot commit either site feature after the global master switch turns OFF', async ({
  extensionWorker, extensionStorage
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{}
  }));
  const pageOrigin = 'https://pending-page.example/*';
  const doubleOrigin = 'https://pending-double.example/*';
  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{
        'pending-page.example':false,
        'pending-double.example':true
      },
      doubleClickBlbSites:{
        'pending-page.example':true,
        'pending-double.example':false
      },
      pendingSiteFeatureToggles:{
        [pageOrigin]:{feature:'pageButton',requestedAt:Date.now()},
        [doubleOrigin]:{feature:'doubleClick',requestedAt:Date.now()}
      }
    });

    // Both prompts were initiated while enabled. The user switches the
    // master gate OFF before Chrome reports either permission grant.
    await extensionStorage.set({masterEnabled:false});
    const before = await extensionWorker.evaluate(async origins => {
      const data = await chrome.storage.local.get({pendingSiteFeatureToggles:{}});
      return origins.map(origin => {
        const intent = data.pendingSiteFeatureToggles[origin];
        const hostname = new URL(origin.slice(0,-1)).hostname;
        return {
          origin,
          present:!!intent,
          feature:intent?.feature,
          requestedAt:intent?.requestedAt,
          sensitive:isSensitiveSiteHostname(hostname),
          hostname
        };
      });
    }, [pageOrigin,doubleOrigin]);
    expect(before.map(item => item.present)).toEqual([true,true]);
    expect(before.map(item => item.feature)).toEqual(['pageButton','doubleClick']);
    expect(before.map(item => item.sensitive)).toEqual([false,false]);

    // Exercise each granted origin independently so the regression identifies
    // which pending feature intent, if any, survives the closed master gate.
    const pageResult = await extensionWorker.evaluate(origin =>
      commitPendingSiteFeatureTogglesForGrantedOrigins([origin]), pageOrigin
    );
    const doubleResult = await extensionWorker.evaluate(origin =>
      commitPendingSiteFeatureTogglesForGrantedOrigins([origin]), doubleOrigin
    );

    expect(pageResult.committed).toEqual([]);
    expect(pageResult.expired).toEqual([pageOrigin]);
    expect(doubleResult.committed).toEqual([]);
    expect(doubleResult.expired).toEqual([doubleOrigin]);

    const stored = await extensionWorker.evaluate(() => chrome.storage.local.get({
      masterEnabled:true,
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{}
    }));
    expect(stored.masterEnabled).toBe(false);
    expect(stored.pageSelectionButtonSites).toMatchObject({
      'pending-page.example':false,
      'pending-double.example':true
    });
    expect(stored.doubleClickBlbSites).toMatchObject({
      'pending-page.example':true,
      'pending-double.example':false
    });
    expect(stored.pendingSiteFeatureToggles).toEqual({});
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
  }
});

test('global redirect ON and OFF reconcile redirect-only runtime registrations on authorized tabs', async ({
  page, extensionWorker, extensionStorage
}) => {
  const hostname = 'example.com';
  const pattern = 'https://example.com/*';
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });

  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  const registration = () => extensionWorker.evaluate(async value => {
    const id = runtimeContentScriptIdForPattern(value);
    return chrome.scripting.getRegisteredContentScripts({ids:[id]});
  }, pattern);

  // No per-site selection preference is enabled: global redirects alone must
  // authorize the shared runtime content-script registration.
  await extensionStorage.set({redirectEnabled:true});
  await expect.poll(registration, {timeout:10000}).toHaveLength(1);

  // Turning redirects OFF must remove the redirect-only registration without
  // changing the independent site-feature preferences or the master switch.
  await extensionStorage.set({redirectEnabled:false});
  await expect.poll(registration, {timeout:10000}).toHaveLength(0);
  const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  }));
  expect(saved).toMatchObject({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
});


test('permission revocation blocks all four actions on an already-open page and regrant restores them', async ({
  page, extensionWorker, extensionStorage
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  }));
  const beforeIds = () => extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  const newBlbTabs = async ids => extensionWorker.evaluate(previousIds =>
    chrome.tabs.query({}).then(tabs => tabs.filter(tab => !previousIds.includes(tab.id) &&
      /^https:\/\/www\.blueletterbible\.org\/kjv\//i.test(tab.url || tab.pendingUrl || ''))
      .map(tab => ({id:tab.id,url:tab.url || tab.pendingUrl || ''}))), ids);
  const select = async (id, reference) => page.evaluate(({id,reference}) => {
    const node = document.getElementById(id) || document.createElement('p');
    node.id = id;
    node.textContent = reference;
    if (!node.isConnected) document.body.appendChild(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  }, {id,reference});
  const waitForPath = async (ids, path) => {
    await expect.poll(async () => (await newBlbTabs(ids)).some(tab => {
      try { return new URL(tab.url).pathname === path; } catch (_) { return false; }
    }), {timeout:12000}).toBe(true);
    return (await newBlbTabs(ids)).find(tab => {
      try { return new URL(tab.url).pathname === path; } catch (_) { return false; }
    });
  };
  try {
    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{'example.com':true}
    });
    await page.route('https://example.com/**', route => route.fulfill({
      status:200, contentType:'text/html',
      body:'<!doctype html><html><head><title>Permission revocation fixture</title></head><body><main>Permission fixture</main></body></html>'
    }));
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
    await page.bringToFront();
    const tabId = await extensionWorker.evaluate(() =>
      chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => tab.id)
    );
    expect(await extensionWorker.evaluate(id => ensureContentScriptInTab(id), tabId)).toBe(true);
    await select('permission-revocation-initial','John 3:16');
    const floating = page.locator('#blb-suite-page-selection-button');
    await expect(floating).toBeVisible({timeout:10000});

    // Keep the real page and its already-injected content script alive. Only
    // the browser permission lookup changes, matching external revocation.
    await extensionWorker.evaluate(async originPattern => {
      globalThis.__permissionRevocationOriginalContains = chrome.permissions.contains;
      chrome.permissions.contains = async details =>
        details?.origins?.includes(originPattern)
          ? false
          : globalThis.__permissionRevocationOriginalContains(details);
      await reconcileRuntimeContentScriptRegistrations();
    }, pattern);
    await expect.poll(() => extensionWorker.evaluate(id =>
      chrome.scripting.getRegisteredContentScripts({ids:[runtimeContentScriptIdForPattern('https://example.com/*')]}).then(items => items.length),
      tabId
    )).toBe(0);

    let ids = await beforeIds();
    await select('permission-revocation-floating-blocked','John 3:16');
    // Playwright's page console event observes extension isolated-world
    // diagnostics as well as page-world messages; replacing window.console in
    // page.evaluate would miss the content script's isolated execution context.
    const permissionDiagnostics = [];
    const capturePermissionDiagnostic = message => {
      const text = message.text();
      if (text.includes('KJV Scripture Tools Show on BLB')) {
        permissionDiagnostics.push({type:message.type(),text});
      }
    };
    page.on('console', capturePermissionDiagnostic);
    try {
      await floating.click();
      await expect.poll(() => permissionDiagnostics.some(message =>
        message.text.includes('host-permission-revoked')
      ), {timeout:5000}).toBe(true);
      expect(permissionDiagnostics.some(message =>
        message.type === 'error' && message.text.includes('action was not completed')
      )).toBe(false);
      expect(permissionDiagnostics.some(message =>
        message.type === 'info' && message.text.includes('host-permission-revoked')
      )).toBe(true);
    } finally {
      page.off('console', capturePermissionDiagnostic);
    }
    await expect(floating).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('John 3:16');
    await page.locator('#permission-revocation-floating-blocked').dblclick();
    const activeTab = await extensionWorker.evaluate(() =>
      chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => tab)
    );
    const rightClickAllowed = await extensionWorker.evaluate(tab =>
      shouldShowBlbContextMenu(tab,'John 3:16'), activeTab);
    expect(rightClickAllowed).toBe(false);
    await extensionWorker.evaluate(tab => handleBlbSelectionContextMenuClick({
      menuItemId:'blb-suite-web-selection',selectionText:'John 3:16'
    },tab), activeTab);
    const altB = await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
    expect(altB).toMatchObject({ok:false,reason:'host-permission-revoked'});
    await expect.poll(() => newBlbTabs(ids)).toHaveLength(0);

    // Restore the exact API and reactivate the same already-open document.
    await extensionWorker.evaluate(async originPattern => {
      chrome.permissions.contains = globalThis.__permissionRevocationOriginalContains;
      delete globalThis.__permissionRevocationOriginalContains;
      await injectEnabledTabsForGrantedOrigins([originPattern]);
    }, pattern);
    await expect.poll(() => extensionWorker.evaluate(id =>
      chrome.scripting.getRegisteredContentScripts({ids:[runtimeContentScriptIdForPattern('https://example.com/*')]}).then(items => items.length),
      tabId
    )).toBe(1);
    await expect(floating).toBeVisible();

    // Floating Button
    ids = await beforeIds();
    await select('permission-revocation-floating-restored','John 3:17');
    await floating.click();
    let opened = await waitForPath(ids,'/kjv/jhn/3/17/');
    await extensionWorker.evaluate(id => chrome.tabs.remove(id),opened.id);

    // Double-click
    await page.bringToFront();
    ids = await beforeIds();
    await select('permission-revocation-double-restored','John 3:18');
    await page.locator('#permission-revocation-double-restored').dblclick();
    opened = await waitForPath(ids,'/kjv/jhn/3/18/');
    await extensionWorker.evaluate(id => chrome.tabs.remove(id),opened.id);

    // Right Click
    await page.bringToFront();
    ids = await beforeIds();
    await select('permission-revocation-right-restored','John 3:19');
    const currentTab = await extensionWorker.evaluate(() =>
      chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => tab)
    );
    expect(await extensionWorker.evaluate(tab => shouldShowBlbContextMenu(tab,'John 3:19'),currentTab)).toBe(true);
    await extensionWorker.evaluate(tab => handleBlbSelectionContextMenuClick({
      menuItemId:'blb-suite-web-selection',selectionText:'John 3:19'
    },tab),currentTab);
    opened = await waitForPath(ids,'/kjv/jhn/3/19/');
    await extensionWorker.evaluate(id => chrome.tabs.remove(id),opened.id);

    // Alt+B
    await page.bringToFront();
    ids = await beforeIds();
    await select('permission-revocation-altb-restored','John 3:20');
    expect(await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand())).toMatchObject({ok:true});
    opened = await waitForPath(ids,'/kjv/jhn/3/20/');
    await extensionWorker.evaluate(id => chrome.tabs.remove(id),opened.id);
  } finally {
    await extensionWorker.evaluate(async ({originPattern,settings}) => {
      if (globalThis.__permissionRevocationOriginalContains) {
        chrome.permissions.contains = globalThis.__permissionRevocationOriginalContains;
        delete globalThis.__permissionRevocationOriginalContains;
      }
      await unregisterRuntimeContentScriptForPattern(originPattern);
      await chrome.storage.local.set(settings);
    }, {originPattern:pattern,settings:previous});
  }
});


test('a late host-permission grant activates the original site tab even after focus moves elsewhere', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{}
  }));
  let otherPage;
  let sameOriginPage;
  try {
    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{}
    });
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
    const originalTabId = await extensionWorker.evaluate(url =>
      chrome.tabs.query({url}).then(([tab]) => tab?.id), 'https://example.com/*'
    );
    expect(Number.isInteger(originalTabId)).toBe(true);

    // A second already-open tab on the same origin must also be activated by
    // the grant, even though it is not the active tab when permission arrives.
    sameOriginPage = await context.newPage();
    await sameOriginPage.goto('https://example.com/second-open-tab', {waitUntil:'domcontentloaded'});
    const secondSameOriginTabId = await extensionWorker.evaluate(() =>
      chrome.tabs.query({url:'https://example.com/second-open-tab'}).then(([tab]) => tab?.id)
    );
    expect(Number.isInteger(secondSameOriginTabId)).toBe(true);

    // Model the popup closing while its permission prompt is pending, followed
    // by the user moving focus to a different tab before Chrome reports grant.
    otherPage = await context.newPage();
    await otherPage.goto('https://example.org/', {waitUntil:'domcontentloaded'});
    const activeTab = await extensionWorker.evaluate(() =>
      chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => tab)
    );
    expect(activeTab?.url).toContain('example.org');

    await extensionStorage.set({
      pendingSiteFeatureToggles:{
        [pattern]:{feature:'pageButton',requestedAt:Date.now()}
      }
    });

    const activation = await extensionWorker.evaluate(async originPattern => {
      const calls = [];
      const original = ensureContentScriptInTab;
      globalThis.__grantActivationOriginalEnsure = original;
      globalThis.__grantActivationCalls = calls;
      ensureContentScriptInTab = async tabId => {
        calls.push(tabId);
        return true;
      };
      try {
        const result = await handleGrantedHostPermissions([originPattern]);
        return {result,calls:[...calls]};
      } finally {
        ensureContentScriptInTab = original;
        delete globalThis.__grantActivationOriginalEnsure;
        delete globalThis.__grantActivationCalls;
      }
    }, pattern);

    expect(activation.result.committed).toEqual([
      {origin:pattern,feature:'pageButton'}
    ]);
    expect(activation.calls).toContain(originalTabId);
    expect(activation.calls).toContain(secondSameOriginTabId);
    expect(activation.calls).not.toContain(activeTab.id);

    const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},doubleClickBlbSites:{},pendingSiteFeatureToggles:{}
    }));
    expect(saved.pageSelectionButtonSites['example.com']).toBe(true);
    expect(saved.doubleClickBlbSites['example.com']).toBeUndefined();
    expect(saved.pendingSiteFeatureToggles).toEqual({});
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
    if (otherPage) await otherPage.close().catch(() => {});
    if (sameOriginPage) await sameOriginPage.close().catch(() => {});
  }
});


test('permission revocation during an in-flight registration cannot leave a persistent content script behind', async ({
  page, extensionWorker, extensionStorage
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  }));
  // Isolate this race from any registration activation left by an earlier
  // test using the worker-scoped extension context.
  await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({
      masterEnabled:false,
      redirectEnabled:false,
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{}
    });
    await Promise.all([...contentScriptInjectionLocks.values()].map(operation => operation.catch(() => {})));
    await Promise.all([...runtimeContentScriptRegistrationLocks.values()].map(operation => operation.catch(() => {})));
    await reconcileRuntimeContentScriptRegistrations();
    await runtimeContentScriptReconciliationQueue;
    await Promise.all([...runtimeContentScriptRegistrationLocks.values()].map(operation => operation.catch(() => {})));
    await runtimeContentScriptReconciliationQueue;
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(() =>
    chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => tab?.id)
  );
  const registrationId = await extensionWorker.evaluate(value =>
    runtimeContentScriptIdForPattern(value), pattern
  );
  const mainWorldId = registrationId + '-main-world';

  try {
    await extensionWorker.evaluate(async ({originPattern, id, mainId}) => {
      await unregisterRuntimeContentScriptForPattern(originPattern);
      await chrome.storage.local.set({
        masterEnabled:false,
        redirectEnabled:false,
        pageSelectionButtonSites:{'example.com':true},
        doubleClickBlbSites:{}
      });
      await reconcileRuntimeContentScriptRegistrations();
      await runtimeContentScriptReconciliationQueue;
      // Keep the master OFF during setup so the storage listener cannot start
      // an uninstrumented activation before the registration gate is installed.
      await unregisterRuntimeContentScriptForPattern(originPattern);

      const originalRegister = chrome.scripting.registerContentScripts;
      let accessGranted = true;
      let signalStarted;
      const started = new Promise(resolve => { signalStarted = resolve; });
      let releaseRegistration;
      const registrationGate = new Promise(resolve => { releaseRegistration = resolve; });

      // Inject a per-call permission check so the test can revoke access at
      // the exact registration boundary without modifying Chrome's native API.
      const permissionCheck = async candidateTab =>
        originPatternForUrl(candidateTab?.url) === originPattern ? accessGranted : true;
      globalThis.__permissionRacePermissionCheck = permissionCheck;
      chrome.scripting.registerContentScripts = async scripts => {
        if (scripts.some(script => script.id === id)) {
          signalStarted();
          await registrationGate;
        }
        return originalRegister.call(chrome.scripting, scripts);
      };

      globalThis.__permissionRaceRestore = () => {
        accessGranted = true;
        delete globalThis.__permissionRacePermissionCheck;
        chrome.scripting.registerContentScripts = originalRegister;
        releaseRegistration();
      };
      globalThis.__permissionRaceRevoke = () => { accessGranted = false; };
      globalThis.__permissionRaceStarted = started;
      globalThis.__permissionRaceRelease = releaseRegistration;
    }, {originPattern:pattern,id:registrationId,mainId:mainWorldId});

    // Keep the real tab out of the activation sweep. Complete normal
    // enabled-site reconciliation before installing the registration gate;
    // otherwise reconciliation itself can enter the gate and deadlock.
    await page.goto('about:blank');
    await extensionWorker.evaluate(async ({originPattern}) => {
      await chrome.storage.local.set({masterEnabled:true});
      await reconcileRuntimeContentScriptRegistrations();
      await runtimeContentScriptReconciliationQueue;
      await Promise.all([...runtimeContentScriptRegistrationLocks.values()].map(operation => operation.catch(() => {})));
      await unregisterRuntimeContentScriptForPattern(originPattern);
    }, {originPattern:pattern});
    // Start the registration helper without awaiting it so the test can revoke
    // access at the exact point where Chrome's registration API is paused.
    await extensionWorker.evaluate(id => {
      globalThis.__permissionRaceActivation = registerRuntimeContentScriptForPattern({url:'https://example.com/',id}, ['content.js'], globalThis.__permissionRacePermissionCheck);
    }, tabId);
    // Wait for the actual registration call to enter its deliberate pause.
    await extensionWorker.evaluate(() => globalThis.__permissionRaceStarted);
    await extensionWorker.evaluate(() => globalThis.__permissionRaceRevoke());
    // Release the paused API call before reconciliation can queue behind it.
    // The helper's post-registration permission check owns cleanup here.
    await extensionWorker.evaluate(() => globalThis.__permissionRaceRelease());
    const activated = await extensionWorker.evaluate(() => globalThis.__permissionRaceActivation);
    expect(activated).toBe(false);

    const remaining = await extensionWorker.evaluate(async ids =>
      chrome.scripting.getRegisteredContentScripts({ids}), [registrationId,mainWorldId]
    );
    expect(remaining).toEqual([]);
  } finally {
    await extensionWorker.evaluate(async ({originPattern,id,mainId,settings}) => {
      globalThis.__permissionRaceRestore?.();
      delete globalThis.__permissionRaceRestore;
      delete globalThis.__permissionRaceRevoke;
      delete globalThis.__permissionRaceStarted;
      delete globalThis.__permissionRaceRelease;
      await unregisterRuntimeContentScriptForPattern(originPattern);
      await chrome.storage.local.set(settings);
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
    }, {originPattern:pattern,id:registrationId,mainId:mainWorldId,settings:previous});
  }
});


test('a site opt-out during an in-flight registration cannot leave the site content script enabled', async ({
  page, extensionWorker
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  }));
  // Isolate this race from any registration activation left by an earlier
  // test using the worker-scoped extension context.
  await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({
      masterEnabled:false,
      redirectEnabled:false,
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{}
    });
    await Promise.all([...contentScriptInjectionLocks.values()].map(operation => operation.catch(() => {})));
    await Promise.all([...runtimeContentScriptRegistrationLocks.values()].map(operation => operation.catch(() => {})));
    await reconcileRuntimeContentScriptRegistrations();
    await runtimeContentScriptReconciliationQueue;
    await Promise.all([...runtimeContentScriptRegistrationLocks.values()].map(operation => operation.catch(() => {})));
    await runtimeContentScriptReconciliationQueue;
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(() =>
    chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => tab?.id)
  );
  const registrationId = await extensionWorker.evaluate(value =>
    runtimeContentScriptIdForPattern(value), pattern
  );
  const mainWorldId = registrationId + '-main-world';

  try {
    await extensionWorker.evaluate(async ({originPattern,id,mainId}) => {
      await chrome.storage.local.set({
        masterEnabled:true,
        redirectEnabled:false,
        pageSelectionButtonSites:{'example.com':true},
        doubleClickBlbSites:{}
      });
      await reconcileRuntimeContentScriptRegistrations();
      await runtimeContentScriptReconciliationQueue;
      // Reconciliation may have queued a registration after its own queue
      // resolved. Drain the per-registration lock before removing the script
      // and installing the interception used by this race test.
      await Promise.all([...runtimeContentScriptRegistrationLocks.values()].map(operation => operation.catch(() => {})));
      await unregisterRuntimeContentScriptForPattern(originPattern);

      const originalRegister = chrome.scripting.registerContentScripts;
      let signalStarted;
      const started = new Promise(resolve => { signalStarted = resolve; });
      let releaseRegistration;
      const registrationGate = new Promise(resolve => { releaseRegistration = resolve; });
      chrome.scripting.registerContentScripts = async scripts => {
        if (scripts.some(script => script.id === id)) {
          signalStarted();
          await registrationGate;
        }
        return originalRegister.call(chrome.scripting, scripts);
      };
      globalThis.__siteOptOutRestore = () => {
        chrome.scripting.registerContentScripts = originalRegister;
        releaseRegistration();
      };
      globalThis.__siteOptOutStarted = started;
      globalThis.__siteOptOutRelease = releaseRegistration;
    }, {originPattern:pattern,id:registrationId,mainId:mainWorldId});

    // Pass the registration ID intercepted above, not a tab ID. Otherwise
    // the registration gate is never entered and the start signal never resolves.
    await extensionWorker.evaluate(id => {
      globalThis.__siteOptOutActivation = registerRuntimeContentScriptForPattern(
        {url:'https://example.com/',id}, ['content.js']
      );
    }, registrationId);
    await extensionWorker.evaluate(() => globalThis.__siteOptOutStarted);

    await extensionWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pageSelectionButtonSites:{'example.com':false}
      });
      await reconcileRuntimeContentScriptRegistrations();
    });
    await extensionWorker.evaluate(() => globalThis.__siteOptOutRelease());
    const activated = await extensionWorker.evaluate(() => globalThis.__siteOptOutActivation);
    expect(activated).toBe(false);

    const remaining = await extensionWorker.evaluate(async ids =>
      chrome.scripting.getRegisteredContentScripts({ids}), [registrationId,mainWorldId]
    );
    expect(remaining).toEqual([]);
  } finally {
    try {
      await extensionWorker.evaluate(async ({originPattern,id,mainId,settings}) => {
        globalThis.__siteOptOutRestore?.();
        delete globalThis.__siteOptOutRestore;
        delete globalThis.__siteOptOutStarted;
        delete globalThis.__siteOptOutRelease;
        await unregisterRuntimeContentScriptForPattern(originPattern);
        await chrome.storage.local.set(settings);
        await reconcileRuntimeContentScriptRegistrations().catch(() => {});
      }, {originPattern:pattern,id:registrationId,mainId:mainWorldId,settings:previous});
    } catch (error) {
      // Preserve the test's original failure if Playwright has already closed
      // the worker after a timeout; otherwise surface genuine cleanup errors.
      if (!String(error).includes('Target page, context or browser has been closed')) {
        throw error;
      }
    }
  }
});


test('host permission revocation immediately hides both global selection menus', async ({ page, extensionWorker, extensionStorage }) => {
  const originPattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true, pageSelectionButtonSites:{}, doubleClickBlbSites:{}, redirectEnabled:false
  }));
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{'example.com':true}
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  try {
    const result = await extensionWorker.evaluate(async pattern => {
      const originalContains = chrome.permissions.contains;
      const originalUpdate = chrome.contextMenus.update;
      const originalWebPresent = selectionMenuKnownPresent;
      const originalPdfPresent = pdfSelectionMenuKnownPresent;
      const updates = [];
      try {
        // Complete any worker-startup menu installation before replacing the
        // API and known-present state; otherwise its asynchronous completion
        // can race this permission-revocation assertion.
        await installWebSelectionContextMenu();
        await installPdfSelectionContextMenu();
        // Settle startup/focus synchronization against the real permission
        // state, then invalidate any older visibility generations before the
        // simulated revocation begins.
        await syncSelectionMenusForFocusedWindow();
        await new Promise(resolve => setTimeout(resolve, 0));
        beginSelectionMenuContextSync();
        webSelectionVisibilitySyncGeneration += 1;
        pdfSelectionVisibilitySyncGeneration += 1;
        selectionMenuKnownPresent = true;
        pdfSelectionMenuKnownPresent = true;
        chrome.permissions.contains = async details =>
          details?.origins?.includes(pattern) ? false : originalContains(details);
        chrome.contextMenus.update = async (id, details) => { updates.push({id, ...details}); };
        await handleHostPermissionsRemoved();
        // Assert each menu's permission-revocation synchronizer directly after
        // the handler's asynchronous focus refresh. This keeps the test focused
        // on visibility policy rather than whichever tab/focus event wins a
        // concurrent global-menu refresh.
        selectionMenuKnownPresent = true;
        await syncWebSelectionContextMenuVisibility({url:'https://example.com/',title:''}, false, () => true);
        // The PDF menu may not be installable in every Chromium test
        // environment (file-URL menu registration is browser-managed). Exercise
        // its visibility synchronizer with a known-present menu as well.
        pdfSelectionMenuKnownPresent = true;
        await syncPdfSelectionContextMenuVisibility({url:'https://example.com/',title:''}, () => true);
        return updates;
      } finally {
        chrome.permissions.contains = originalContains;
        chrome.contextMenus.update = originalUpdate;
        selectionMenuKnownPresent = originalWebPresent;
        pdfSelectionMenuKnownPresent = originalPdfPresent;
      }
    }, originPattern);

    expect(result).toEqual(expect.arrayContaining([
      {id:'blb-suite-web-selection', visible:false},
      {id:'blb-suite-pdf-selection', visible:false}
    ]));
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
  }
});


test('permission revocation invalidates only matching pending popup opt-ins and preserves saved preferences', async ({
  extensionWorker, extensionStorage
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{},
    siteFeaturePreferenceRequestIds:{},
    siteHostAccessRevokedSites:{}
  }));
  const revokedOrigin = 'https://example.com/*';
  const unrelatedOrigin = 'https://other.example/*';
  const revokedRequestId = 'popup-a-pending-request';
  const unrelatedRequestId = 'popup-b-unrelated-request';
  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'example.com':false,'other.example':true},
      doubleClickBlbSites:{'example.com':true,'other.example':false},
      pendingSiteFeatureToggles:{
        [revokedOrigin]:{feature:'pageButton',requestedAt:Date.now(),requestId:revokedRequestId},
        [unrelatedOrigin]:{feature:'doubleClick',requestedAt:Date.now(),requestId:unrelatedRequestId}
      },
      siteFeaturePreferenceRequestIds:{
        [revokedOrigin + '|pageButton']:revokedRequestId,
        [unrelatedOrigin + '|doubleClick']:unrelatedRequestId
      }
    });

    // Model Chrome reporting the permission as revoked while a second popup's
    // permissions.request promise is still unresolved.
    await extensionWorker.evaluate(async origin => {
      const contains = chrome.permissions.contains;
      chrome.permissions.contains = async details =>
        details?.origins?.includes(origin) ? false : contains(details);
      try {
        await updateRevokedSiteHostAccess([origin], true);
      } finally {
        chrome.permissions.contains = contains;
      }
    }, revokedOrigin);

    const afterRevocation = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{},
      siteFeaturePreferenceRequestIds:{}
    }));
    expect(afterRevocation.pageSelectionButtonSites).toMatchObject({
      'example.com':false,'other.example':true
    });
    expect(afterRevocation.doubleClickBlbSites).toMatchObject({
      'example.com':true,'other.example':false
    });
    expect(afterRevocation.pendingSiteFeatureToggles[revokedOrigin]).toBeUndefined();
    expect(afterRevocation.pendingSiteFeatureToggles[unrelatedOrigin]).toMatchObject({
      feature:'doubleClick',requestId:unrelatedRequestId
    });
    expect(afterRevocation.siteFeaturePreferenceRequestIds[revokedOrigin + '|pageButton']).toBeUndefined();
    expect(afterRevocation.siteFeaturePreferenceRequestIds[unrelatedOrigin + '|doubleClick']).toBe(unrelatedRequestId);

    // A delayed grant callback from the revoked popup cannot resurrect its
    // stale request. An unrelated site's pending intent remains eligible.
    const lateGrant = await extensionWorker.evaluate(origin =>
      commitPendingSiteFeatureTogglesForGrantedOrigins([origin]), revokedOrigin
    );
    expect(lateGrant.committed).toEqual([]);
    const unrelatedGrant = await extensionWorker.evaluate(origin =>
      commitPendingSiteFeatureTogglesForGrantedOrigins([origin]), unrelatedOrigin
    );
    expect(unrelatedGrant.committed).toEqual([{origin:unrelatedOrigin,feature:'doubleClick'}]);

    const finalState = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{}
    }));
    expect(finalState.pageSelectionButtonSites['example.com']).toBe(false);
    expect(finalState.doubleClickBlbSites['example.com']).toBe(true);
    expect(finalState.doubleClickBlbSites['other.example']).toBe(true);
    expect(finalState.pendingSiteFeatureToggles[revokedOrigin]).toBeUndefined();
    expect(finalState.pendingSiteFeatureToggles[unrelatedOrigin]).toBeUndefined();
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
  }
});


test('worker-start recovery commits only pending site opt-ins whose host permission is still granted', async ({
  extensionWorker, extensionStorage
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{},
    siteFeaturePreferenceRequestIds:{},
    siteHostAccessRevokedSites:{}
  }));
  const grantedOrigin = 'https://recovered.example/*';
  const revokedOrigin = 'https://still-revoked.example/*';
  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{
        [grantedOrigin]:{feature:'pageButton',requestedAt:Date.now(),requestId:'restart-granted'},
        [revokedOrigin]:{feature:'doubleClick',requestedAt:Date.now(),requestId:'restart-revoked'}
      },
      siteFeaturePreferenceRequestIds:{
        [grantedOrigin + '|pageButton']:'restart-granted',
        [revokedOrigin + '|doubleClick']:'restart-revoked'
      }
    });

    const recovered = await extensionWorker.evaluate(async ({granted,revoked}) => {
      const originalContains = chrome.permissions.contains;
      chrome.permissions.contains = async details => {
        if (details?.origins?.includes(granted)) return true;
        if (details?.origins?.includes(revoked)) return false;
        return originalContains(details);
      };
      try {
        return await recoverPendingSiteFeatureTogglesAfterWorkerStart();
      } finally {
        chrome.permissions.contains = originalContains;
      }
    }, {granted:grantedOrigin,revoked:revokedOrigin});

    expect(recovered).toMatchObject({
      committed:[{origin:grantedOrigin,feature:'pageButton'}],
      checked:2
    });
    const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{},
      siteFeaturePreferenceRequestIds:{}
    }));
    expect(saved.pageSelectionButtonSites['recovered.example']).toBe(true);
    expect(saved.doubleClickBlbSites['still-revoked.example']).toBeUndefined();
    expect(saved.pendingSiteFeatureToggles[grantedOrigin]).toBeUndefined();
    expect(saved.pendingSiteFeatureToggles[revokedOrigin]).toMatchObject({
      feature:'doubleClick',requestId:'restart-revoked'
    });
    expect(saved.siteFeaturePreferenceRequestIds[revokedOrigin + '|doubleClick']).toBe('restart-revoked');
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
  }
});


test('an explicit feature OFF wins against a late grant while overlapping same-origin feature prompts remain independent', async ({
  context, extensionWorker, extensionStorage, extensionId
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{},
    siteFeaturePreferenceRequestIds:{}
  }));
  const origin = 'https://overlapping-prompts.example/*';
  const pageRequestId = 'overlap-page-request';
  const doubleRequestId = 'overlap-double-request';
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    for (const ordering of ['off-before-grant','grant-before-off']) {
      await extensionStorage.set({
        masterEnabled:true,
        pageSelectionButtonSites:{'overlapping-prompts.example':false},
        doubleClickBlbSites:{'overlapping-prompts.example':false},
        pendingSiteFeatureToggles:{
          [origin]:{features:{
            pageButton:{requestedAt:Date.now(),requestId:pageRequestId},
            doubleClick:{requestedAt:Date.now(),requestId:doubleRequestId}
          }}
        },
        siteFeaturePreferenceRequestIds:{
          [origin + '|pageButton']:pageRequestId,
          [origin + '|doubleClick']:doubleRequestId
        }
      });

      const turnPageButtonOff = async () => popup.evaluate(async ({origin,requestId}) =>
        chrome.runtime.sendMessage({
          type:'blbSuiteSetSiteFeaturePreference',
          origin,
          feature:'pageButton',
          enabled:false,
          requestId
        }), {origin,requestId:'explicit-page-off-' + ordering}
      );

      if (ordering === 'off-before-grant') {
        expect((await turnPageButtonOff()).ok).toBe(true);
        const grant = await extensionWorker.evaluate(value =>
          commitPendingSiteFeatureTogglesForGrantedOrigins([value]), origin
        );
        expect(grant.committed).toEqual([{origin,feature:'doubleClick'}]);
      } else {
        const grant = await extensionWorker.evaluate(value =>
          commitPendingSiteFeatureTogglesForGrantedOrigins([value]), origin
        );
        expect(grant.committed).toEqual(expect.arrayContaining([
          {origin,feature:'pageButton'},
          {origin,feature:'doubleClick'}
        ]));
        expect((await turnPageButtonOff()).ok).toBe(true);
      }

      const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
        pageSelectionButtonSites:{},
        doubleClickBlbSites:{},
        pendingSiteFeatureToggles:{}
      }));
      expect(saved.pageSelectionButtonSites['overlapping-prompts.example']).toBe(false);
      expect(saved.doubleClickBlbSites['overlapping-prompts.example']).toBe(true);
      expect(saved.pendingSiteFeatureToggles[origin]).toBeUndefined();
    }
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings), previous);
    await popup.close().catch(() => {});
  }
});


test('closing and reopening the popup fences an older permission response behind the newer OFF choice', async ({
  context, extensionWorker, extensionStorage, extensionId
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{}
  }));
  const origin = 'https://popup-reopen-race.example/*';
  let firstPopup;
  let reopenedPopup;
  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{'popup-reopen-race.example':false},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{},
      siteFeaturePreferenceRequestIds:{}
    });
    firstPopup = await context.newPage();
    await firstPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    const prepared = await firstPopup.evaluate(async origin => chrome.runtime.sendMessage({
      type:'blbSuitePrepareSiteFeatureToggle',origin,feature:'pageButton'
    }),origin);
    expect(prepared).toMatchObject({ok:true,pending:true});
    await firstPopup.close();
    firstPopup = null;

    reopenedPopup = await context.newPage();
    await reopenedPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    const off = await reopenedPopup.evaluate(async origin => chrome.runtime.sendMessage({
      type:'blbSuiteSetSiteFeaturePreference',
      origin,feature:'pageButton',enabled:false,
      requestId:'reopened-popup-explicit-off'
    }),origin);
    expect(off.ok).toBe(true);

    // Simulate the first popup's permission request resolving after the
    // replacement popup has already made a newer explicit OFF choice.
    const lateGrant = await extensionWorker.evaluate(value =>
      commitPendingSiteFeatureTogglesForGrantedOrigins([value]),origin);
    expect(lateGrant.committed).toEqual([]);
    const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{}
    }));
    expect(saved.pageSelectionButtonSites['popup-reopen-race.example']).toBe(false);
    expect(saved.pendingSiteFeatureToggles[origin]).toBeUndefined();
    expect(saved.siteFeaturePreferenceRequestIds[origin + '|pageButton']).toBe('reopened-popup-explicit-off');
  } finally {
    await firstPopup?.close().catch(() => {});
    await reopenedPopup?.close().catch(() => {});
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings),previous);
    await extensionWorker.evaluate(() => chrome.alarms.clear(SITE_FEATURE_PERMISSION_PENDING_CLEANUP_ALARM));
  }
});

test('abandoned permission intents expire and lose their request token after the popup closes', async ({
  context, extensionWorker, extensionStorage, extensionId
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{}
  }));
  const origin = 'https://abandoned-popup-intent.example/*';
  let popup;
  try {
    await extensionStorage.set({
      masterEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{}
    });
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const prepared = await popup.evaluate(async origin => chrome.runtime.sendMessage({
      type:'blbSuitePrepareSiteFeatureToggle',origin,feature:'doubleClick'
    }),origin);
    expect(prepared.ok).toBe(true);
    await popup.close();
    popup = null;

    const cleanup = await extensionWorker.evaluate(() =>
      pruneExpiredPendingSiteFeatureToggles(Date.now()+SITE_FEATURE_PERMISSION_PENDING_TTL_MS+10)
    );
    expect(cleanup.expired).toContain(origin);
    const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{},doubleClickBlbSites:{}
    }));
    expect(saved.pendingSiteFeatureToggles[origin]).toBeUndefined();
    expect(saved.siteFeaturePreferenceRequestIds[origin + '|doubleClick']).toBeUndefined();
    expect(saved.doubleClickBlbSites['abandoned-popup-intent.example']).toBeUndefined();

    const lateGrant = await extensionWorker.evaluate(value =>
      commitPendingSiteFeatureTogglesForGrantedOrigins([value]),origin);
    expect(lateGrant.committed).toEqual([]);
  } finally {
    await popup?.close().catch(() => {});
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings),previous);
    await extensionWorker.evaluate(() => chrome.alarms.clear(SITE_FEATURE_PERMISSION_PENDING_CLEANUP_ALARM));
  }
});


test('cleanup alarm scheduling re-reads the newest pending intents instead of applying a stale snapshot', async ({
  extensionWorker, extensionStorage
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{}
  }));
  const origin = 'https://newer-alarm-intent.example/*';
  const requestedAt = Date.now();
  try {
    await extensionStorage.set({
      pendingSiteFeatureToggles:{
        [origin]:{feature:'pageButton',requestedAt,requestId:'newer-alarm-request'}
      },
      siteFeaturePreferenceRequestIds:{
        [origin + '|pageButton']:'newer-alarm-request'
      }
    });

    // A cleanup operation may finish with an older empty snapshot just as a
    // second popup creates a new intent. Scheduling must always re-read the
    // serialized latest storage state rather than trusting that old snapshot.
    await extensionWorker.evaluate(async () => {
      await schedulePendingSiteFeatureToggleCleanup({});
    });
    const alarm = await extensionWorker.evaluate(() =>
      chrome.alarms.get(SITE_FEATURE_PERMISSION_PENDING_CLEANUP_ALARM)
    );
    expect(alarm).toBeTruthy();
    expect(alarm.scheduledTime).toBeGreaterThan(requestedAt);
    expect(alarm.scheduledTime).toBeLessThanOrEqual(
      requestedAt + 5 * 60 * 1000 + 2000
    );
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings),previous);
    await extensionWorker.evaluate(() => chrome.alarms.clear(SITE_FEATURE_PERMISSION_PENDING_CLEANUP_ALARM));
  }
});


test('grant-time expiry removes only the matching expired permission request token', async ({
  extensionWorker, extensionStorage
}) => {
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,pageSelectionButtonSites:{},doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{}
  }));
  const origin = 'https://grant-time-expiry.example/*';
  const expiredRequestId = 'expired-page-button-request';
  const currentRequestId = 'current-double-click-request';
  const now = Date.now() + 5 * 60 * 1000 + 100;
  try {
    await extensionStorage.set({
      masterEnabled:true,
      pageSelectionButtonSites:{},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{
        [origin]:{features:{
          pageButton:{requestedAt:now - 5 * 60 * 1000 - 10,requestId:expiredRequestId},
          doubleClick:{requestedAt:now - 1000,requestId:currentRequestId}
        }}
      },
      siteFeaturePreferenceRequestIds:{
        [origin + '|pageButton']:expiredRequestId,
        [origin + '|doubleClick']:currentRequestId
      }
    });

    const result = await extensionWorker.evaluate(({value,at}) =>
      commitPendingSiteFeatureTogglesForGrantedOrigins([value],at), {value:origin,at:now});
    expect(result).toEqual({
      committed:[{origin,feature:'doubleClick'}],
      expired:[origin]
    });

    const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{}
    }));
    expect(saved.pendingSiteFeatureToggles[origin]).toBeUndefined();
    expect(saved.pageSelectionButtonSites['grant-time-expiry.example']).toBeUndefined();
    expect(saved.doubleClickBlbSites['grant-time-expiry.example']).toBe(true);
    expect(saved.siteFeaturePreferenceRequestIds[origin + '|pageButton']).toBeUndefined();
    // The committed feature keeps its token so a delayed failure rollback can
    // still be fenced against a newer explicit preference.
    expect(saved.siteFeaturePreferenceRequestIds[origin + '|doubleClick']).toBe(currentRequestId);
  } finally {
    await extensionWorker.evaluate(settings => chrome.storage.local.set(settings),previous);
    await extensionWorker.evaluate(() => chrome.alarms.clear(SITE_FEATURE_PERMISSION_PENDING_CLEANUP_ALARM));
  }
});


test('worker-start recovery removes stale persisted host registrations even when no permission intent is pending', async ({
  extensionWorker, extensionStorage
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{},
    siteFeaturePreferenceRequestIds:{},
    siteHostAccessRevokedSites:{}
  }));
  try {
    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{},
      siteFeaturePreferenceRequestIds:{}
    });
    // Seed the Chrome-persisted registration directly. This fixture represents
    // a registration left behind by an interrupted cleanup; it should not
    // depend on the normal registration eligibility path or a live tab grant.
    const registrationId = await extensionWorker.evaluate(async value => {
      const id = runtimeContentScriptIdForPattern(value);
      await chrome.scripting.registerContentScripts([{
        id,
        matches:[value],
        js:['content.js'],
        runAt:'document_start',
        persistAcrossSessions:true
      }]);
      return id;
    }, pattern);
    await expect.poll(() => extensionWorker.evaluate(async id =>
      (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length === 1,
      registrationId
    )).toBe(true);

    await extensionWorker.evaluate(async origin => {
      const original = chrome.permissions.contains;
      chrome.permissions.contains = async details =>
        details?.origins?.includes(origin) ? false : original(details);
      try {
        // Simulates a cold worker activation after the revocation callback
        // failed or was interrupted; there is deliberately no pending intent.
        await recoverRuntimeContentScriptRegistrationsAfterWorkerStart();
      } finally {
        chrome.permissions.contains = original;
      }
    }, pattern);

    await expect.poll(() => extensionWorker.evaluate(async id =>
      (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length === 0,
      registrationId
    )).toBe(true);
    const saved = await extensionWorker.evaluate(() => chrome.storage.local.get({
      pageSelectionButtonSites:{},pendingSiteFeatureToggles:{},siteFeaturePreferenceRequestIds:{}
    }));
    expect(saved.pageSelectionButtonSites['example.com']).toBe(true);
    expect(saved.pendingSiteFeatureToggles).toEqual({});
    expect(saved.siteFeaturePreferenceRequestIds).toEqual({});
  } finally {
    await extensionWorker.evaluate(async ({origin,settings}) => {
      const id = runtimeContentScriptIdForPattern(origin);
      await chrome.scripting.unregisterContentScripts({ids:[id]}).catch(() => {});
      await chrome.storage.local.set(settings);
    }, {origin:pattern,settings:previous});
    await extensionWorker.evaluate(() => chrome.alarms.clear(SITE_FEATURE_PERMISSION_PENDING_CLEANUP_ALARM));
  }
});


test('an immediate host-permission regrant waits for an older revocation reconciliation before reactivating the site', async ({
  page, extensionWorker, extensionStorage
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    siteHostAccessRevokedSites:{}
  }));
  let instrumentationInstalled = false;
  try {
    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{'example.com':true},
      doubleClickBlbSites:{}
    });
    await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
    const tabId = await extensionWorker.evaluate(() =>
      chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => tab?.id)
    );
    expect(Number.isInteger(tabId)).toBe(true);
    expect(await extensionWorker.evaluate(id => ensureContentScriptInTab(id), tabId)).toBe(true);

    const registrationId = await extensionWorker.evaluate(value =>
      runtimeContentScriptIdForPattern(value), pattern
    );
    const isRegistered = () => extensionWorker.evaluate(async id =>
      (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length === 1,
      registrationId
    );
    await expect.poll(isRegistered, {timeout:10000}).toBe(true);

    await extensionWorker.evaluate(({originPattern,id}) => {
      const originalContains = chrome.permissions.contains;
      const originalUnregister = chrome.scripting.unregisterContentScripts;
      const originalUpdateRevoked = updateRevokedSiteHostAccess;
      const originalInjectGranted = injectEnabledTabsForGrantedOrigins;
      let signalUnregisterStarted;
      let signalGrantStateUpdated;
      let signalInjectionStarted;
      let releaseUnregister;
      const unregisterStarted = new Promise(resolve => { signalUnregisterStarted = resolve; });
      const grantStateUpdated = new Promise(resolve => { signalGrantStateUpdated = resolve; });
      const injectionStarted = new Promise(resolve => { signalInjectionStarted = resolve; });
      const unregisterGate = new Promise(resolve => { releaseUnregister = resolve; });

      globalThis.__permissionRegrantRace = {
        unregisterStarted,
        grantStateUpdated,
        injectionStarted,
        releaseUnregister,
        originalContains,
        originalUnregister,
        originalUpdateRevoked,
        originalInjectGranted
      };
      chrome.permissions.contains = async details =>
        details?.origins?.includes(originPattern) ? false : originalContains(details);
      chrome.scripting.unregisterContentScripts = async details => {
        if (details?.ids?.includes(id)) {
          signalUnregisterStarted();
          await unregisterGate;
        }
        return originalUnregister.call(chrome.scripting, details);
      };
      globalThis.updateRevokedSiteHostAccess = async (origins, revoked) => {
        const result = await originalUpdateRevoked(origins, revoked);
        if (revoked === false) signalGrantStateUpdated();
        return result;
      };
      globalThis.injectEnabledTabsForGrantedOrigins = async origins => {
        signalInjectionStarted();
        return originalInjectGranted(origins);
      };
    }, {originPattern:pattern,id:registrationId});
    instrumentationInstalled = true;

    // Start the real revocation handler and pause its registration removal
    // after it has observed the old no-permission state.
    await extensionWorker.evaluate(originPattern => {
      globalThis.__permissionRegrantRace.revocationPromise =
        handleHostPermissionsRemoved([originPattern]);
    }, pattern);
    await extensionWorker.evaluate(() => globalThis.__permissionRegrantRace.unregisterStarted);

    // Chrome reports the same host as granted again while the older removal
    // callback is still waiting to unregister its stale snapshot.
    await extensionWorker.evaluate(originPattern => {
      const race = globalThis.__permissionRegrantRace;
      chrome.permissions.contains = async details =>
        details?.origins?.includes(originPattern) ? true : race.originalContains(details);
      race.grantPromise = handleGrantedHostPermissions([originPattern]);
    }, pattern);
    await extensionWorker.evaluate(() => globalThis.__permissionRegrantRace.grantStateUpdated);

    const injectedBeforeRevocationCleanup = await extensionWorker.evaluate(() =>
      Promise.race([
        globalThis.__permissionRegrantRace.injectionStarted.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 100))
      ])
    );
    expect(injectedBeforeRevocationCleanup).toBe(false);

    // Once the older cleanup finishes, the regrant handler must reconcile
    // against current permission state and activate the saved site preference.
    await extensionWorker.evaluate(() => globalThis.__permissionRegrantRace.releaseUnregister());
    await extensionWorker.evaluate(async () => {
      const race = globalThis.__permissionRegrantRace;
      await race.revocationPromise;
      await race.grantPromise;
    });
    await expect.poll(isRegistered, {timeout:10000}).toBe(true);
  } finally {
    if (instrumentationInstalled) {
      await extensionWorker.evaluate(async () => {
        const race = globalThis.__permissionRegrantRace;
        if (!race) return;
        race.releaseUnregister();
        await Promise.allSettled([race.revocationPromise, race.grantPromise].filter(Boolean));
        chrome.permissions.contains = race.originalContains;
        chrome.scripting.unregisterContentScripts = race.originalUnregister;
        globalThis.updateRevokedSiteHostAccess = race.originalUpdateRevoked;
        globalThis.injectEnabledTabsForGrantedOrigins = race.originalInjectGranted;
        delete globalThis.__permissionRegrantRace;
      }).catch(() => {});
    }
    await extensionWorker.evaluate(async ({originPattern,settings}) => {
      await chrome.storage.local.set(settings);
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
      await unregisterRuntimeContentScriptForPattern(originPattern).catch(() => {});
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
    }, {originPattern:pattern,settings:previous});
  }
});
