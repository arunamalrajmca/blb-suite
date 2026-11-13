const { test, expect } = require('./fixtures');

test('host-access revocation removes registrations and later grants reactivate each independently enabled site feature', async ({
  page, extensionWorker, extensionStorage
}) => {
  const pattern = 'https://example.com/*';
  const previous = await extensionWorker.evaluate(async () => chrome.storage.local.get({
    masterEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    redirectEnabled:false
  }));

  const scenarios = [
    { label:'Show on BLB only', pageButton:true, doubleClick:false },
    { label:'Double-click only', pageButton:false, doubleClick:true },
    { label:'both features', pageButton:true, doubleClick:true }
  ];

  try {
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

      await extensionWorker.evaluate(async originPattern =>
        unregisterRuntimeContentScriptForPattern(originPattern), pattern
      );
    }
  } finally {
    await extensionWorker.evaluate(async ({originPattern,settings}) => {
      const id=runtimeContentScriptIdForPattern(originPattern);
      await chrome.scripting.unregisterContentScripts({ids:[id,id+'-main-world']}).catch(() => {});
      await chrome.storage.local.set(settings);
    }, {originPattern:pattern,settings:previous});
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
      const id = runtimeContentScriptIdForPattern(originPattern);
      await chrome.scripting.unregisterContentScripts({ids:[id,id+'-main-world']}).catch(() => {});
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
      await registerRuntimeContentScriptForPattern({url:optOut}, ['content.js']);
      await registerRuntimeContentScriptForPattern({url:sensitive}, ['content.js']);
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
        const id = runtimeContentScriptIdForPattern(pattern);
        await chrome.scripting.unregisterContentScripts({ids:[id,id+'-main-world']}).catch(() => {});
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
    await floating.click();
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
      const id = runtimeContentScriptIdForPattern(originPattern);
      await chrome.scripting.unregisterContentScripts({ids:[id,id+'-main-world']}).catch(() => {});
      await chrome.storage.local.set(settings);
    }, {originPattern:pattern,settings:previous});
  }
});
