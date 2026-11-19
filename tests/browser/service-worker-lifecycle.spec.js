const { test, expect } = require('./fixtures');

test('a real MV3 service-worker termination is recovered by a content-script selection request', async ({ page, context, extensionStorage, extensionWorker, extensionId }) => {
  await extensionStorage.set({
    masterEnabled:true,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => !!document.documentElement);

  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  // Install a one-shot bridge in the content script's isolated world before
  // terminating the worker. The later page event makes that resident content
  // script call the real chrome.runtime.sendMessage API after worker shutdown.
  await extensionWorker.evaluate(async id => {
    await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => {
        window.addEventListener('blb-suite-test-wake-worker', async () => {
          const response = await safeRuntimeSendMessage({
            type:'blbSuiteOpenSelectionText',
            requestId:'e2e-real-worker-wake-john-3-16',
            text:'John 3:16',
            contextualReferenceResolved:true
          });
          document.documentElement.dataset.blbServiceWorkerWakeResult = JSON.stringify(response ?? null);
        }, {once:true});
      }
    });
  }, tabId);

  const browser = context.browser();
  expect(browser, 'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp = await browser.newBrowserCDPSession();
  let observer;
  try {
    await cdp.send('Target.setDiscoverTargets', {discover:true});
    const {targetInfos} = await cdp.send('Target.getTargets');
    const workerTarget = targetInfos.find(target =>
      target.type === 'service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget, 'extension service-worker target must be discoverable').toBeTruthy();

    const closed = await cdp.send('Target.closeTarget', {targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);

    await expect.poll(async () => {
      const {targetInfos:currentTargets} = await cdp.send('Target.getTargets');
      return currentTargets.some(target => target.targetId === workerTarget.targetId);
    }, {timeout:5000}).toBe(false);

    await page.evaluate(() => window.dispatchEvent(new Event('blb-suite-test-wake-worker')));

    await page.waitForFunction(() => {
      return Object.prototype.hasOwnProperty.call(
        document.documentElement.dataset,
        'blbServiceWorkerWakeResult'
      );
    }, null, {timeout:10000});
    const response = await page.evaluate(() =>
      JSON.parse(document.documentElement.dataset.blbServiceWorkerWakeResult)
    );
    expect(response).toMatchObject({ok:true});

    // The original service-worker target was confirmed closed above. A
    // successful response to this real runtime message proves Chromium woke
    // a fresh worker to dispatch and complete the selection request.
  } finally {
    await cdp.detach();
  }
});


test('a real Chrome alarm wakes a terminated MV3 worker and auto-stops an inactive Study recording', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  // The test intentionally leaves the worker stopped until its 65-second alarm is due.
  // Allow the alarm event and persisted-state assertion to complete beyond Playwright's 60s default.
  test.setTimeout(150000);
  await extensionStorage.set({
    masterEnabled:true,
    studyAutoStopMinutes:5
  });
  const topic = 'MV3 alarm wake regression ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
  const started = await extensionWorker.evaluate(value =>
    startStudyTopicFromPopup(value, 'Preserve this note across worker wake'), topic
  );
  expect(started).toMatchObject({ok:true, recording:true, topic:normalizedTopic});

  await extensionStorage.set({
    studyLastActivityAt:Date.now() - 6 * 60 * 1000
  });
  // Replace the normal periodic alarm with a one-shot alarm far enough in the
  // future to first prove that the worker has terminated. Chrome may clamp
  // short alarm delays to its minimum; the test waits for the actual alarm
  // event rather than calling checkStudyAutoStop directly.
  await extensionWorker.evaluate(() => chrome.alarms.create(STUDY_AUTOSTOP_ALARM, {
    when:Date.now() + 65000
  }));
  const alarm = await extensionWorker.evaluate(() =>
    chrome.alarms.get(STUDY_AUTOSTOP_ALARM)
  );
  expect(alarm).toBeTruthy();

  const browser = context.browser();
  expect(browser, 'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp = await browser.newBrowserCDPSession();
  let observer;
  try {
    await cdp.send('Target.setDiscoverTargets', {discover:true});
    const {targetInfos} = await cdp.send('Target.getTargets');
    const workerTarget = targetInfos.find(target =>
      target.type === 'service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget, 'extension service-worker target must be discoverable').toBeTruthy();

    const closed = await cdp.send('Target.closeTarget', {targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:currentTargets} = await cdp.send('Target.getTargets');
      return currentTargets.some(target => target.targetId === workerTarget.targetId);
    }, {timeout:5000}).toBe(false);

    // Let the one-shot alarm become due while no extension page is open to
    // restart the worker. Only then open the storage observer; loading popup
    // UI before termination can itself wake/retain the worker and invalidate
    // the lifecycle assertion.
    await new Promise(resolve => setTimeout(resolve, 70000));
    observer = await context.newPage();
    await observer.goto('chrome-extension://' + extensionId + '/popup.html');

    // A storage-only read from the extension page observes the alarm handler's
    // result without issuing a runtime message to wake the worker.
    await expect.poll(async () => observer.evaluate(async expectedTopic => {
      const data = await chrome.storage.local.get({
        currentStudySessionId:null,
        studyPauseReason:'',
        studyPausedTopic:'',
        studySessions:[]
      });
      return {
        stopped:data.currentStudySessionId === null,
        reason:data.studyPauseReason,
        topic:data.studyPausedTopic,
        note:data.studySessions.some(session => session.title === expectedTopic &&
          session.notes.includes('Preserve This Note Across Worker Wake'))
      };
    }, normalizedTopic), {timeout:50000, intervals:[250,500,1000,2000]}).toEqual({
      stopped:true,
      reason:'inactivity',
      topic:normalizedTopic,
      note:true
    });
  } finally {
    await cdp.detach();
    if (observer) await observer.close();
  }
});

test('a real MV3 service-worker termination is recovered by an actual Double-click selection', async ({
  page, context, extensionStorage, extensionId
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{'example.com':true}
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await page.evaluate(() => {
    const target=document.createElement('p');
    target.id='double-click-worker-wake-reference';
    target.textContent='John 3:16';
    document.body.appendChild(target);
  });
  await page.waitForTimeout(500);

  const browser=context.browser();
  expect(browser, 'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp=await browser.newBrowserCDPSession();
  try {
    await cdp.send('Target.setDiscoverTargets',{discover:true});
    const {targetInfos}=await cdp.send('Target.getTargets');
    const workerTarget=targetInfos.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget,'extension service-worker target must be discoverable').toBeTruthy();

    const closed=await cdp.send('Target.closeTarget',{targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target => target.targetId===workerTarget.targetId);
    },{timeout:5000}).toBe(false);

    // This is the real page gesture and the dedicated Double-click message
    // path, not a direct call into the background handler.
    await page.locator('#double-click-worker-wake-reference').dblclick();

    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target =>
        target.type==='page' &&
        (() => { try { const url=new URL(target.url); return url.hostname==='www.blueletterbible.org' && url.pathname==='/kjv/jhn/3/16/'; } catch (_) { return false; } })()
      );
    },{timeout:15000,intervals:[100,200,500,1000]}).toBe(true);

    const {targetInfos:recoveredTargets}=await cdp.send('Target.getTargets');
    const recoveredWorker=recoveredTargets.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(recoveredWorker,'Double-click must wake the extension service worker').toBeTruthy();
  } finally {
    await cdp.detach();
  }
});

test('a real MV3 service-worker termination is recovered by the Alt+B command message', async ({
  page, context, extensionStorage, extensionWorker, extensionId
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await page.evaluate(() => {
    const target=document.createElement('p');
    target.id='alt-b-worker-wake-reference';
    target.textContent='John 3:16';
    document.body.appendChild(target);
    const range=document.createRange();
    range.selectNodeContents(target);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const tabId=await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);

  // The registered Alt+B command uses this runtime message to hand the
  // current page selection to the service worker. Install a one-shot bridge
  // before termination so the same message can be sent after the worker dies.
  await extensionWorker.evaluate(async id => {
    await chrome.scripting.executeScript({
      target:{tabId:id},
      world:'ISOLATED',
      func:() => {
        window.addEventListener('blb-suite-test-alt-b-wake', async () => {
          const response=await new Promise((resolve,reject) => {
            chrome.runtime.sendMessage({type:'blbSuiteOpenCurrentSelection'}, result => {
              if(chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(result ?? null);
            });
          });
          document.documentElement.dataset.blbAltBWorkerWakeResult=JSON.stringify(response);
        },{once:true});
      }
    });
  },tabId);

  const browser=context.browser();
  expect(browser,'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp=await browser.newBrowserCDPSession();
  try {
    await cdp.send('Target.setDiscoverTargets',{discover:true});
    const {targetInfos}=await cdp.send('Target.getTargets');
    const workerTarget=targetInfos.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget,'extension service-worker target must be discoverable').toBeTruthy();

    const closed=await cdp.send('Target.closeTarget',{targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target => target.targetId===workerTarget.targetId);
    },{timeout:5000}).toBe(false);

    // Send the exact runtime handoff used by the registered Alt+B command.
    await page.evaluate(() => window.dispatchEvent(new Event('blb-suite-test-alt-b-wake')));

    await page.waitForFunction(() =>
      Object.prototype.hasOwnProperty.call(
        document.documentElement.dataset,'blbAltBWorkerWakeResult'
      ),null,{timeout:10000}
    );
    const response=await page.evaluate(() =>
      JSON.parse(document.documentElement.dataset.blbAltBWorkerWakeResult)
    );
    expect(response).toMatchObject({ok:true});

    const {targetInfos:recoveredTargets}=await cdp.send('Target.getTargets');
    expect(recoveredTargets.some(target =>
      target.type==='page' &&
      (() => {
        try {
          const url=new URL(target.url);
          return url.hostname==='www.blueletterbible.org' &&
            url.pathname==='/kjv/jhn/3/16/';
        } catch (_) { return false; }
      })()
    ),'Alt+B command handoff must open the expected BLB passage').toBe(true);
    expect(recoveredTargets.some(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    ),'Alt+B command handoff must wake the extension service worker').toBe(true);
  } finally {
    await cdp.detach();
  }
});

test('a real MV3 service-worker termination is recovered by the actual Floating Show on BLB action', async ({
  page, context, extensionStorage, extensionId
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  await page.goto('https://example.com/', {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const target=document.createElement('p');
    target.id='floating-button-worker-wake-reference';
    target.textContent='John 3:16';
    document.body.appendChild(target);
    const range=document.createRange();
    range.selectNodeContents(target);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });

  const floatingButton=page.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible({timeout:10000});

  const browser=context.browser();
  expect(browser,'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp=await browser.newBrowserCDPSession();
  try {
    await cdp.send('Target.setDiscoverTargets',{discover:true});
    const {targetInfos}=await cdp.send('Target.getTargets');
    const workerTarget=targetInfos.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget,'extension service-worker target must be discoverable').toBeTruthy();

    const closed=await cdp.send('Target.closeTarget',{targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target => target.targetId===workerTarget.targetId);
    },{timeout:5000}).toBe(false);

    // Click the real floating control after the worker is confirmed stopped.
    // Its content-script message must wake a fresh worker and open the passage.
    await floatingButton.click();

    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target =>
        target.type==='page' &&
        (() => {
          try {
            const url=new URL(target.url);
            return url.hostname==='www.blueletterbible.org' &&
              url.pathname==='/kjv/jhn/3/16/';
          } catch (_) { return false; }
        })()
      );
    },{timeout:15000,intervals:[100,200,500,1000]}).toBe(true);

    const {targetInfos:recoveredTargets}=await cdp.send('Target.getTargets');
    const recoveredWorker=recoveredTargets.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(recoveredWorker,'Floating Show on BLB must wake the extension service worker').toBeTruthy();  } finally {
    await cdp.detach();
  }
});


test('a real MV3 service-worker termination is recovered by navigation on a configured site', async ({
  page, context, extensionStorage, extensionId
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  await page.goto('https://example.com/?blb-worker-recovery=initial', {waitUntil:'domcontentloaded'});

  const selectReferenceAndShowFloatingAction = async () => {
    await page.evaluate(() => {
      const target=document.createElement('p');
      target.id='navigation-worker-wake-reference';
      target.textContent='John 3:16';
      document.body.appendChild(target);
      const range=document.createRange();
      range.selectNodeContents(target);
      const selection=window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    });
    await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible({timeout:10000});
  };

  // The floating action is selection-dependent: first prove that the site's
  // saved Show on BLB preference is active before terminating the worker.
  await selectReferenceAndShowFloatingAction();

  const browser=context.browser();
  expect(browser,'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp=await browser.newBrowserCDPSession();
  try {
    await cdp.send('Target.setDiscoverTargets',{discover:true});
    const {targetInfos}=await cdp.send('Target.getTargets');
    const workerTarget=targetInfos.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget,'extension service-worker target must be discoverable').toBeTruthy();

    const closed=await cdp.send('Target.closeTarget',{targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target => target.targetId===workerTarget.targetId);
    },{timeout:5000}).toBe(false);

    // A real top-level navigation emits tabs.onUpdated while the extension
    // worker is stopped. Verify that this event wakes a fresh worker before
    // exercising the selection-dependent content-script UI on the new page.
    await page.goto('https://example.com/?blb-worker-recovery=navigated', {waitUntil:'domcontentloaded'});
    await expect.poll(async () => {
      const {targetInfos:current}=await cdp.send('Target.getTargets');
      return current.some(target =>
        target.type==='service_worker' &&
        target.url.startsWith(`chrome-extension://${extensionId}/`)
      );
    },{timeout:15000,intervals:[100,200,500,1000]}).toBe(true);

    await selectReferenceAndShowFloatingAction();
  } finally {
    await cdp.detach();
  }
});

test('a replaced MV3 tab migrates extension-owned destination and MultiVerse state', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => {
    const addedTabId = 940001;
    const removedTabId = 940002;
    const logicalKey = 'lifecycle-replaced-tab-test';
    const scriptTaggerKey = 'script-tagger|lifecycle-replaced-tab-test';
    const storageKeys = ['blbSuiteMultiVerseTabSets', 'blbSuitePendingMultiVerseRefsByTab'];
    const previousStorage = await chrome.storage.local.get(storageKeys);
    const hadTracked = Object.prototype.hasOwnProperty.call(previousStorage, storageKeys[0]);
    const hadPending = Object.prototype.hasOwnProperty.call(previousStorage, storageKeys[1]);
    const previousLogical = blbLogicalTabRegistry.get(logicalKey);
    const hadLogical = blbLogicalTabRegistry.has(logicalKey);
    const previousIntentional = intentionalNewBlbTabs.has(removedTabId);
    const previousScriptTagger = scriptTaggerDestinationTabs.get(scriptTaggerKey);
    const hadScriptTagger = scriptTaggerDestinationTabs.has(scriptTaggerKey);
    const previousGetLiveTabById = getLiveTabById;

    const currentRef = {book:'John', chapter:3, from:16, to:16};
    const retainedRef = {book:'Acts', chapter:2, from:1, to:1};
    const migratedRef = {book:'Romans', chapter:8, from:1, to:2};
    try {
      // This test uses synthetic tab IDs to exercise state migration without
      // opening browser tabs. Treat the destination as live for the new
      // post-migration liveness guard.
      getLiveTabById = async tabId => tabId === addedTabId
        ? {id:addedTabId,url:'https://example.com/'}
        : previousGetLiveTabById(tabId);
      blbLogicalTabRegistry.set(logicalKey, removedTabId);
      intentionalNewBlbTabs.add(removedTabId);
      scriptTaggerDestinationTabs.set(scriptTaggerKey, removedTabId);
      await chrome.storage.local.set({
        blbSuiteMultiVerseTabSets: {
          [String(removedTabId)]: {destination:'multiverse', batch:3}
        },
        blbSuitePendingMultiVerseRefsByTab: {
          [String(removedTabId)]: [currentRef, migratedRef],
          [String(addedTabId)]: [currentRef, retainedRef]
        }
      });

      await handleReplacedTabIdentity(addedTabId, removedTabId);
      const stored = await chrome.storage.local.get(storageKeys);
      return {
        logicalTabId: blbLogicalTabRegistry.get(logicalKey),
        intentionalNew: intentionalNewTabState(),
        scriptTaggerTabId: scriptTaggerDestinationTabs.get(scriptTaggerKey),
        tracked: stored.blbSuiteMultiVerseTabSets,
        pending: stored.blbSuitePendingMultiVerseRefsByTab
      };
      function intentionalNewTabState() {
        return intentionalNewBlbTabs.has(addedTabId) && !intentionalNewBlbTabs.has(removedTabId);
      }
    } finally {
      getLiveTabById = previousGetLiveTabById;
      if (hadLogical) blbLogicalTabRegistry.set(logicalKey, previousLogical);
      else blbLogicalTabRegistry.delete(logicalKey);
      if (previousIntentional) intentionalNewBlbTabs.add(removedTabId);
      else intentionalNewBlbTabs.delete(removedTabId);
      intentionalNewBlbTabs.delete(addedTabId);
      if (hadScriptTagger) scriptTaggerDestinationTabs.set(scriptTaggerKey, previousScriptTagger);
      else scriptTaggerDestinationTabs.delete(scriptTaggerKey);
      if (hadTracked) await chrome.storage.local.set({blbSuiteMultiVerseTabSets:previousStorage.blbSuiteMultiVerseTabSets});
      else await chrome.storage.local.remove(storageKeys[0]);
      if (hadPending) await chrome.storage.local.set({blbSuitePendingMultiVerseRefsByTab:previousStorage.blbSuitePendingMultiVerseRefsByTab});
      else await chrome.storage.local.remove(storageKeys[1]);
    }
  });

  expect(result.logicalTabId).toBe(940001);
  expect(result.intentionalNew).toBe(true);
  expect(result.scriptTaggerTabId).toBe(940001);
  expect(result.tracked).toEqual({
    '940001': {destination:'multiverse', batch:3}
  });
  expect(result.pending).toEqual({
    '940001': [
      {book:'John', chapter:3, from:16, to:16},
      {book:'Acts', chapter:2, from:1, to:1},
      {book:'Romans', chapter:8, from:1, to:2}
    ]
  });
});
  
test('a replaced prerendered tab is activated when startup registration recovery may have missed it', async ({
  context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},
    doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  await page.goto('https://example.com/?replacement-recovery=1', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({url:'https://example.com/*'});
    return tabs[0]?.id;
  });
  expect(tabId).toBeTruthy();

  try {
    const activated = await extensionWorker.evaluate(async id => {
      const original = ensureContentScriptInTab;
      const calls = [];
      ensureContentScriptInTab = async tabId => {
        calls.push(tabId);
        return true;
      };
      try {
        await handleReplacedTabIdentity(id, 940003);
        return calls;
      } finally {
        ensureContentScriptInTab = original;
      }
    }, tabId);
    expect(activated).toContain(tabId);
  } finally {
    await page.close().catch(() => {});
    await extensionStorage.set({
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{}
    });
    await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations().catch(() => {}));
  }
});


test('closing multiple MultiVerse tabs concurrently removes every persisted tab record', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => {
    const keys = ['blbSuiteMultiVerseTabSets', 'blbSuitePendingMultiVerseRefsByTab'];
    const previous = await chrome.storage.local.get(keys);
    const hadTracked = Object.prototype.hasOwnProperty.call(previous, keys[0]);
    const hadPending = Object.prototype.hasOwnProperty.call(previous, keys[1]);
    const sentinelId = '940099';
    const created = [];
    try {
      const first = await chrome.tabs.create({url:'about:blank', active:false});
      const second = await chrome.tabs.create({url:'about:blank', active:false});
      created.push(first.id, second.id);
      const firstId = String(first.id);
      const secondId = String(second.id);
      await chrome.storage.local.set({
        blbSuiteMultiVerseTabSets: {
          [firstId]: {key:'concurrent-close-first', batch:1},
          [secondId]: {key:'concurrent-close-second', batch:2},
          [sentinelId]: {key:'unrelated-live-tab', batch:3}
        },
        blbSuitePendingMultiVerseRefsByTab: {
          [firstId]: [{book:'John', chapter:3, from:16, to:16}],
          [secondId]: [{book:'Romans', chapter:8, from:1, to:2}],
          [sentinelId]: [{book:'Acts', chapter:2, from:1, to:1}]
        }
      });

      await Promise.all(created.map(tabId => chrome.tabs.remove(tabId)));
      const deadline = Date.now() + 5000;
      let stored;
      do {
        stored = await chrome.storage.local.get(keys);
        const tracked = stored.blbSuiteMultiVerseTabSets || {};
        const pending = stored.blbSuitePendingMultiVerseRefsByTab || {};
        if (!tracked[firstId] && !tracked[secondId] && !pending[firstId] && !pending[secondId]) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);

      return {
        tracked: stored.blbSuiteMultiVerseTabSets,
        pending: stored.blbSuitePendingMultiVerseRefsByTab,
        removedIds: created
      };
    } finally {
      await Promise.all(created.map(tabId => chrome.tabs.remove(tabId).catch(() => {})));
      if (hadTracked) await chrome.storage.local.set({blbSuiteMultiVerseTabSets:previous.blbSuiteMultiVerseTabSets});
      else await chrome.storage.local.remove(keys[0]);
      if (hadPending) await chrome.storage.local.set({blbSuitePendingMultiVerseRefsByTab:previous.blbSuitePendingMultiVerseRefsByTab});
      else await chrome.storage.local.remove(keys[1]);
    }
  });

  expect(result.tracked).toEqual({
    '940099': {key:'unrelated-live-tab', batch:3}
  });
  expect(result.pending).toEqual({
    '940099': [{book:'Acts', chapter:2, from:1, to:1}]
  });
});


test('content-script requests are rejected when their originating document navigates during authorization', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true});
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><body><p>BLB message lifecycle fixture</p></body></html>'
  }));
  await page.goto('https://www.blueletterbible.org/', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  expect(Number.isInteger(tabId)).toBe(true);
  const originalDocumentId = await extensionWorker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({
      target:{tabId:id},
      func:() => true
    });
    return result.documentId;
  }, tabId);
  expect(originalDocumentId).toBeTruthy();

  await extensionWorker.evaluate(documentId => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.__blbMessageLifecycleTest = {
      started:false,
      authorizationFinished:false,
      liveDocumentResult:null,
      targetDocumentId:documentId,
      recordCalls:0,
      release,
      originalPermissionCheck:hasSelectionActionPermissionForTab,
      originalRecordStudyRefs:recordStudyRefs,
      originalLiveDocumentCheck:isLiveContentScriptSenderDocument
    };
    hasSelectionActionPermissionForTab = async () => {
      globalThis.__blbMessageLifecycleTest.started = true;
      await gate;
      globalThis.__blbMessageLifecycleTest.authorizationFinished = true;
      return true;
    };
    isLiveContentScriptSenderDocument = async sender => {
      const result = await globalThis.__blbMessageLifecycleTest.originalLiveDocumentCheck(sender);
      if (sender.documentId === globalThis.__blbMessageLifecycleTest.targetDocumentId) {
        globalThis.__blbMessageLifecycleTest.liveDocumentResult = result;
      }
      return result;
    };
    recordStudyRefs = async refs => {
      globalThis.__blbMessageLifecycleTest.recordCalls += 1;
      return refs.length;
    };
  }, originalDocumentId);

  try {
    await extensionWorker.evaluate(async id => {
      await chrome.scripting.executeScript({
        target:{tabId:id},
        world:'ISOLATED',
        func:() => {
          void chrome.runtime.sendMessage({
            type:'blbSuiteCaptureStudyRefs',
            refs:[{book:'John',chapter:3,from:16,to:16}]
          }).then(response => {
            document.documentElement.dataset.blbStaleDocumentMessageResponse = JSON.stringify(response);
          }).catch(error => {
            document.documentElement.dataset.blbStaleDocumentMessageResponse = String(error);
          });
          return true;
        }
      });
    }, tabId);

    await expect.poll(() => extensionWorker.evaluate(() =>
      globalThis.__blbMessageLifecycleTest.started
    )).toBe(true);

    // Reload the same URL while the background permission check is held.
    // The URL and tab ID remain unchanged, but the original document ID does not.
    await page.reload({waitUntil:'domcontentloaded'});
    await extensionWorker.evaluate(() => globalThis.__blbMessageLifecycleTest.release());

    await expect.poll(() => extensionWorker.evaluate(() =>
      globalThis.__blbMessageLifecycleTest.liveDocumentResult
    )).toBe(false);
    const outcome = await extensionWorker.evaluate(() => ({
      authorizationFinished:globalThis.__blbMessageLifecycleTest.authorizationFinished,      liveDocumentResult:globalThis.__blbMessageLifecycleTest.liveDocumentResult,
      recordCalls:globalThis.__blbMessageLifecycleTest.recordCalls
    }));
    expect(outcome).toEqual({
      authorizationFinished:true,
      liveDocumentResult:false,
      recordCalls:0
    });
  } finally {
    await extensionWorker.evaluate(() => {
      const state = globalThis.__blbMessageLifecycleTest;
      if (!state) return;
      hasSelectionActionPermissionForTab = state.originalPermissionCheck;
      recordStudyRefs = state.originalRecordStudyRefs;
      isLiveContentScriptSenderDocument = state.originalLiveDocumentCheck;
      delete globalThis.__blbMessageLifecycleTest;
    });
  }
});

test('content-script messages from subframes are rejected even when the frame has a live document', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true});
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><body><iframe src="https://www.blueletterbible.org/frame"></iframe></body></html>'
  }));
  await page.goto('https://www.blueletterbible.org/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.readyState === 'complete');
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );
  const frames = await extensionWorker.evaluate(async id =>
    chrome.scripting.executeScript({
      target:{tabId:id,allFrames:true},
      func:() => ({isTop:window.top===window,href:location.href})
    }), tabId);
  const frame = frames.find(result => result.frameId !== 0);
  expect(frame?.documentId).toBeTruthy();

  const authorized = await extensionWorker.evaluate(async ({id,url,frameId,documentId}) =>
    isAuthorizedContentScriptSender({
      id:chrome.runtime.id,
      tab:{id,url},
      url,
      frameId,
      documentId
    }), {
      id:tabId,
      url:'https://www.blueletterbible.org/frame',
      frameId:frame.frameId,
      documentId:frame.documentId
    }
  );
  expect(authorized).toBe(false);
});

test('asynchronous content-script handlers keep sendResponse open until delayed work completes', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true});
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><body><p>Async response fixture</p></body></html>'
  }));
  await page.goto('https://www.blueletterbible.org/', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );

  await extensionWorker.evaluate(() => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.__blbAsyncResponseTest = {
      started:false,
      release,
      originalRecordStudyRefs:recordStudyRefs
    };
    recordStudyRefs = async refs => {
      globalThis.__blbAsyncResponseTest.started = true;
      await gate;
      return refs.length;
    };
  });

  try {
    await extensionWorker.evaluate(async id => {
      await chrome.scripting.executeScript({
        target:{tabId:id},
        world:'ISOLATED',
        func:() => {
          void chrome.runtime.sendMessage({
            type:'blbSuiteCaptureStudyRefs',
            refs:[{book:'John',chapter:3,from:16,to:16}]
          }).then(response => {
            document.documentElement.dataset.blbAsyncResponseResult = JSON.stringify(response);
          }).catch(error => {
            document.documentElement.dataset.blbAsyncResponseResult = String(error);
          });
          return true;
        }
      });
    }, tabId);

    await expect.poll(() => extensionWorker.evaluate(() =>
      globalThis.__blbAsyncResponseTest.started
    )).toBe(true);
    await page.waitForTimeout(100);
    expect(await page.locator('html').getAttribute('data-blb-async-response-result')).toBeNull();

    await extensionWorker.evaluate(() => globalThis.__blbAsyncResponseTest.release());
    await expect.poll(() => page.locator('html').getAttribute('data-blb-async-response-result'))
      .toBe(JSON.stringify({ok:true,added:1}));
  } finally {
    await extensionWorker.evaluate(() => {
      const state = globalThis.__blbAsyncResponseTest;
      if (!state) return;
      recordStudyRefs = state.originalRecordStudyRefs;
      delete globalThis.__blbAsyncResponseTest;
    });
  }
});


test('every asynchronous message type has an explicit trusted sender category', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(() => ({
    unclassified:Array.from(ASYNC_MESSAGE_TYPES).filter(type =>
      !EXTENSION_PAGE_MESSAGE_SOURCES.has(type) && !CONTENT_SCRIPT_MESSAGE_TYPES.has(type)
    ),
    popupMessageAccepted:isAuthorizedExtensionPageMessage(
      {type:'blbSuiteGetStudyUiState'},
      {id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')}
    ),
    popupMessageRejectedFromWrongPage:isAuthorizedExtensionPageMessage(
      {type:'blbSuiteGetStudyUiState'},
      {id:chrome.runtime.id,url:chrome.runtime.getURL('Tutorial.html')}
    ),
    unregisteredMessageAccepted:isAuthorizedExtensionPageMessage(
      {type:'blbSuiteUnregisteredMessage'},
      {id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')}
    )
  }));

  expect(result).toEqual({
    unclassified:[],
    popupMessageAccepted:true,
    popupMessageRejectedFromWrongPage:false,
    unregisteredMessageAccepted:false
  });
});


test('content-script requests are rejected when their originating tab closes during authorization', async ({
  page, context, extensionWorker, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true});
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><body><p>Closed-tab message lifecycle fixture</p></body></html>'
  }));
  await page.goto('https://www.blueletterbible.org/', {waitUntil:'domcontentloaded'});
  const tabId = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id
  );

  await extensionWorker.evaluate(() => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.__blbClosedTabMessageTest = {
      started:false,
      liveDocumentResult:null,
      recordCalls:0,
      release,
      originalPermissionCheck:hasSelectionActionPermissionForTab,
      originalRecordStudyRefs:recordStudyRefs,
      originalLiveDocumentCheck:isLiveContentScriptSenderDocument
    };
    hasSelectionActionPermissionForTab = async () => {
      globalThis.__blbClosedTabMessageTest.started = true;
      await gate;
      return true;
    };
    isLiveContentScriptSenderDocument = async sender => {
      const result = await globalThis.__blbClosedTabMessageTest.originalLiveDocumentCheck(sender);
      globalThis.__blbClosedTabMessageTest.liveDocumentResult = result;
      return result;
    };
    recordStudyRefs = async refs => {
      globalThis.__blbClosedTabMessageTest.recordCalls += 1;
      return refs.length;
    };
  });

  try {
    await extensionWorker.evaluate(async id => {
      await chrome.scripting.executeScript({
        target:{tabId:id},
        world:'ISOLATED',
        func:() => {
          void chrome.runtime.sendMessage({
            type:'blbSuiteCaptureStudyRefs',
            refs:[{book:'John',chapter:3,from:16,to:16}]
          }).catch(() => {});
          return true;
        }
      });
    }, tabId);

    await expect.poll(() => extensionWorker.evaluate(() =>
      globalThis.__blbClosedTabMessageTest.started
    )).toBe(true);
    await page.close();
    await extensionWorker.evaluate(() => globalThis.__blbClosedTabMessageTest.release());

    await expect.poll(() => extensionWorker.evaluate(() =>
      globalThis.__blbClosedTabMessageTest.liveDocumentResult
    )).toBe(false);
    const outcome = await extensionWorker.evaluate(() => ({
      liveDocumentResult:globalThis.__blbClosedTabMessageTest.liveDocumentResult,
      recordCalls:globalThis.__blbClosedTabMessageTest.recordCalls
    }));
    expect(outcome).toEqual({liveDocumentResult:false,recordCalls:0});
  } finally {
    await extensionWorker.evaluate(() => {
      const state = globalThis.__blbClosedTabMessageTest;
      if (!state) return;
      hasSelectionActionPermissionForTab = state.originalPermissionCheck;
      recordStudyRefs = state.originalRecordStudyRefs;
      isLiveContentScriptSenderDocument = state.originalLiveDocumentCheck;
      delete globalThis.__blbClosedTabMessageTest;
    });
  }
});

test('selection request deduplication is scoped to the originating tab and document', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(() => {
    const requestId = 'cross-tab-collision-' + Date.now();
    const firstKey = 'request|940101|document-a|' + requestId;
    const secondKey = 'request|940102|document-b|' + requestId;
    const replacementDocumentKey = 'request|940101|document-a-reloaded|' + requestId;
    try {
      return {
        firstTab:shouldAcceptSelectionOpenRequest(940101, 'John 3:16', requestId, 'document-a'),
        secondTab:shouldAcceptSelectionOpenRequest(940102, 'Romans 8:28', requestId, 'document-b'),
        duplicateFirstDocument:shouldAcceptSelectionOpenRequest(940101, 'John 3:16', requestId, 'document-a'),
        replacementDocument:shouldAcceptSelectionOpenRequest(940101, 'John 3:16', requestId, 'document-a-reloaded')
      };
    } finally {
      recentSelectionOpenRequests.delete(firstKey);
      recentSelectionOpenRequests.delete(secondKey);
      recentSelectionOpenRequests.delete(replacementDocumentKey);
    }
  });

  expect(result).toEqual({
    firstTab:true,
    secondTab:true,
    duplicateFirstDocument:false,
    replacementDocument:true
  });
});

test('a terminated worker reconciles stale host registrations and expires pending intents on its next real activation', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  const pattern = 'https://example.com/*';
  const pendingOrigin = 'https://no-permission.example/*';
  const requestId = 'worker-restart-expired-intent-' + Date.now();
  const requestKey = pendingOrigin + '|pageButton';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{},
    pendingSiteFeatureToggles:{},
    siteFeaturePreferenceRequestIds:{},
    siteHostAccessRevokedSites:{}
  }));
  let observer;
  let cdp;
  try {
    await extensionStorage.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{'example.com':false},
      doubleClickBlbSites:{},
      pendingSiteFeatureToggles:{
        [pendingOrigin]:{
          feature:'pageButton',
          requestedAt:Date.now()-6*60*1000,
          requestId
        }
      },
      siteFeaturePreferenceRequestIds:{[requestKey]:requestId}
    });
    const registrationId = await extensionWorker.evaluate(async value => {      const id = runtimeContentScriptIdForPattern(value);
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

    const browser = context.browser();
    expect(browser, 'persistent context must expose its Chromium browser').not.toBeNull();
    cdp = await browser.newBrowserCDPSession();
    await cdp.send('Target.setDiscoverTargets',{discover:true});
    const {targetInfos} = await cdp.send('Target.getTargets');
    const originalWorker = targetInfos.find(target =>
      target.type==='service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(originalWorker,'extension service-worker target must be discoverable').toBeTruthy();

    const closed = await cdp.send('Target.closeTarget',{targetId:originalWorker.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:current} = await cdp.send('Target.getTargets');
      return current.some(target => target.targetId===originalWorker.targetId);
    },{timeout:5000}).toBe(false);

    // A successful response to a real extension-page message proves that
    // Chromium started a worker after the original target was confirmed closed.
    // Do not depend on Playwright's serviceworker event: Chromium can omit that
    // event for a restarted worker in an already-running persistent context.
    observer = await context.newPage();
    await observer.goto(`chrome-extension://${extensionId}/popup.html`);
    const response = await observer.evaluate(() =>
      chrome.runtime.sendMessage({type:'blbSuiteGetStudyUiState'})
    );
    expect(response?.ok).toBe(true);

    // Observe cleanup through the extension page after the real runtime message
    // has woken the worker; this verifies startup recovery without calling its
    // helper directly or relying on a Playwright worker-event notification.
    await expect.poll(() => observer.evaluate(async id => {
      const [registered] = await chrome.scripting.getRegisteredContentScripts({ids:[id]});
      const saved = await chrome.storage.local.get({
        pageSelectionButtonSites:{},
        pendingSiteFeatureToggles:{},
        siteFeaturePreferenceRequestIds:{}
      });
      return {
        registrationPresent:Boolean(registered),
        pagePreference:saved.pageSelectionButtonSites['example.com'],
        pending:saved.pendingSiteFeatureToggles,
        requestIds:saved.siteFeaturePreferenceRequestIds
      };
    },registrationId),{timeout:10000,intervals:[100,250,500,1000]}).toEqual({
      registrationPresent:false,
      pagePreference:false,
      pending:{},
      requestIds:{}
    });
  } finally {
    if (observer) {
      await observer.evaluate(async ({origin,settings}) => {
        const id = runtimeContentScriptIdForPattern(origin);
        await chrome.scripting.unregisterContentScripts({ids:[id]}).catch(() => {});
        await chrome.storage.local.set(settings);
        await chrome.alarms.clear('site-feature-permission-pending-cleanup');
      },{origin:pattern,settings:previous}).catch(() => {});
      await observer.close().catch(() => {});
    } else if (extensionWorker.isClosed?.() !== true) {
      await extensionWorker.evaluate(settings => chrome.storage.local.set(settings),previous).catch(() => {});
    }
    await cdp?.detach().catch(() => {});
  }
});


test('browser restart reconciles persisted host registrations and pending permission intents using the same profile', async ({
  extensionPath
}) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {chromium} = require('@playwright/test');
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(),'blb-worker-browser-restart-'));
  const launch = () => chromium.launchPersistentContext(profilePath,{
    channel:'chromium',
    headless:true,
    args:[
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  let browserContext;
  let restartedContext;
  try {
    browserContext = await launch();
    let [worker] = browserContext.serviceWorkers();
    if (!worker) worker = await browserContext.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    const pattern = 'https://example.com/*';
    const pendingOrigin = 'https://no-permission.example/*';
    const requestId = 'browser-restart-expired-intent-' + Date.now();
    const requestKey = pendingOrigin + '|pageButton';

    const registrationId = await worker.evaluate(async ({value,request,tokenKey,token}) => {
      // This fixture deliberately seeds a stale registration for an opted-out
      // host. Suppress the production storage-change reconciliation only while
      // constructing that persisted pre-restart state; otherwise the normal
      // listener correctly removes the registration before the restart test
      // can exercise startup reconciliation.
      const originalReconcile = reconcileRuntimeContentScriptRegistrations;
      let resolveSeedStorageChange;
      const seedStorageChange = new Promise(resolve => {
        resolveSeedStorageChange = resolve;
      });
      const observeSeedStorageChange = (changes, area) => {
        if (area !== 'local' || !changes.pageSelectionButtonSites) return;
        chrome.storage.onChanged.removeListener(observeSeedStorageChange);
        resolveSeedStorageChange();
      };
      reconcileRuntimeContentScriptRegistrations = () => Promise.resolve();
      chrome.storage.onChanged.addListener(observeSeedStorageChange);
      try {
        await chrome.storage.local.set({
          masterEnabled:true,
          redirectEnabled:false,
          pageSelectionButtonSites:{'example.com':false},
          doubleClickBlbSites:{},
          pendingSiteFeatureToggles:{
            [request]:{
              feature:'pageButton',
              requestedAt:Date.now()-6*60*1000,
              requestId:token
            }
          },
          siteFeaturePreferenceRequestIds:{[tokenKey]:token}
        });
        await seedStorageChange;
        const id = runtimeContentScriptIdForPattern(value);
        await chrome.scripting.registerContentScripts([{
          id,
          matches:[value],
          js:['content.js'],
          runAt:'document_start',
          persistAcrossSessions:true
        }]);
        return id;
      } finally {
        chrome.storage.onChanged.removeListener(observeSeedStorageChange);
        reconcileRuntimeContentScriptRegistrations = originalReconcile;
      }
    },{value:pattern,request:pendingOrigin,tokenKey:requestKey,token:requestId});
    await expect.poll(() => worker.evaluate(async id =>
      (await chrome.scripting.getRegisteredContentScripts({ids:[id]})).length===1,
      registrationId
    )).toBe(true);

    // Close the whole browser context, not just its worker. The explicit user
    // data directory is reused below to exercise persisted Chrome state.
    await browserContext.close();
    browserContext = null;

    restartedContext = await launch();
    let [restartedWorker] = restartedContext.serviceWorkers();
    if (!restartedWorker) restartedWorker = await restartedContext.waitForEvent('serviceworker');
    expect(restartedWorker.url().split('/')[2]).toBe(extensionId);

    await expect.poll(() => restartedWorker.evaluate(async id => {
      const [registered] = await chrome.scripting.getRegisteredContentScripts({ids:[id]});
      const saved = await chrome.storage.local.get({
        pageSelectionButtonSites:{},
        pendingSiteFeatureToggles:{},
        siteFeaturePreferenceRequestIds:{}
      });
      return {
        registrationPresent:Boolean(registered),
        pagePreference:saved.pageSelectionButtonSites['example.com'],
        pending:saved.pendingSiteFeatureToggles,
        requestIds:saved.siteFeaturePreferenceRequestIds
      };
    },registrationId),{timeout:15000,intervals:[100,250,500,1000]}).toEqual({
      registrationPresent:false,
      pagePreference:false,
      pending:{},
      requestIds:{}
    });
  } finally {
    await restartedContext?.close().catch(() => {});
    await browserContext?.close().catch(() => {});
    fs.rmSync(profilePath,{recursive:true,force:true});
  }
});

test('browser startup reconciles multiple stale registrations and mixed expired, valid, and ungranted permission intents', async ({
  extensionPath
}) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {chromium} = require('@playwright/test');
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(),'blb-mixed-permission-startup-'));
  const launch = () => chromium.launchPersistentContext(profilePath,{
    channel:'chromium',
    headless:true,
    args:[
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  let browserContext;
  let restartedContext;
  try {
    browserContext = await launch();
    let [worker] = browserContext.serviceWorkers();
    if (!worker) worker = await browserContext.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];

    // The browser fixture adds these hosts to the test extension's granted
    // host_permissions. The final origin is intentionally absent from that
    // list so its still-valid permission intent must remain pending.
    const validPattern = 'https://www.dailyverses.net/*';
    const expiredPattern = 'https://www.gotquestions.org/*';
    const stalePatternTwo = 'https://www.facebook.com/*';
    const stalePatternThree = 'https://www.supplyofgrace.com/*';
    const missingPermissionPattern = 'https://no-permission-startup.invalid/*';
    const validRequestId = 'startup-valid-' + Date.now();
    const expiredRequestId = 'startup-expired-' + Date.now();
    const missingRequestId = 'startup-missing-' + Date.now();
    const validRequestKey = validPattern + '|pageButton';
    const expiredRequestKey = expiredPattern + '|doubleClick';
    const missingRequestKey = missingPermissionPattern + '|pageButton';

    const seeded = await worker.evaluate(async values => {
      const hasMissingPermission = await chrome.permissions.contains({
        origins:[values.missingPermissionPattern]
      });
      if (hasMissingPermission) throw new Error('The missing-permission test origin unexpectedly has host access');

      // The storage-change listener normally reconciles registrations as
      // soon as these opt-out settings are written. Suppress only that
      // pre-restart notification while constructing the persisted legacy
      // state; restore the real reconciler before closing and restarting Chrome.
      const originalReconcile = reconcileRuntimeContentScriptRegistrations;
      let observeStorageChange;
      const storageChangeObserved = new Promise(resolve => {
        observeStorageChange = (changes, area) => {
          if (area === 'local' && changes.pageSelectionButtonSites) {
            chrome.storage.onChanged.removeListener(observeStorageChange);
            resolve();
          }
        };
        chrome.storage.onChanged.addListener(observeStorageChange);
      });
      reconcileRuntimeContentScriptRegistrations = async () => {};
      try {
        await chrome.storage.local.set({
          masterEnabled:true,
          redirectEnabled:false,
          pageSelectionButtonSites:{
            'dailyverses.net':false,
            'example.com':false,
            'facebook.com':false,
            'supplyofgrace.com':false
          },
          doubleClickBlbSites:{},
          pendingSiteFeatureToggles:{
            [values.validPattern]:{
              feature:'pageButton',
              requestedAt:Date.now(),
              requestId:values.validRequestId
            },
            [values.expiredPattern]:{
              feature:'doubleClick',
              requestedAt:Date.now()-6*60*1000,
              requestId:values.expiredRequestId
            },
            [values.missingPermissionPattern]:{
              feature:'pageButton',
              requestedAt:Date.now(),
              requestId:values.missingRequestId
            }
          },
          siteFeaturePreferenceRequestIds:{
            [values.validRequestKey]:values.validRequestId,
            [values.expiredRequestKey]:values.expiredRequestId,
            [values.missingRequestKey]:values.missingRequestId
          },
          siteHostAccessRevokedSites:{}
        });
        await storageChangeObserved;
      } finally {
        reconcileRuntimeContentScriptRegistrations = originalReconcile;
        chrome.storage.onChanged.removeListener(observeStorageChange);
      }

      const patterns = [
        values.validPattern,
        values.expiredPattern,
        values.stalePatternTwo,
        values.stalePatternThree
      ];
      const registrations = [];
      for (const pattern of patterns) {
        const id = runtimeContentScriptIdForPattern(pattern);
        await chrome.scripting.registerContentScripts([{
          id,
          matches:[pattern],
          js:['content.js'],
          runAt:'document_start',
          persistAcrossSessions:true
        }]);
        registrations.push({pattern,id});
      }
      const saved = await chrome.storage.local.get({
        pendingSiteFeatureToggles:{},
        siteFeaturePreferenceRequestIds:{},
        pageSelectionButtonSites:{}
      });
      return {registrations,saved,hasMissingPermission};
    },{
      validPattern,expiredPattern,stalePatternTwo,stalePatternThree,
      missingPermissionPattern,validRequestId,expiredRequestId,missingRequestId,
      validRequestKey,expiredRequestKey,missingRequestKey
    });
    expect(seeded.hasMissingPermission).toBe(false);
    expect(seeded.registrations).toHaveLength(4);
    await expect.poll(() => worker.evaluate(async ids => {
      const all = await chrome.scripting.getRegisteredContentScripts();
      return all.filter(entry => ids.includes(entry.id)).length;
    },seeded.registrations.map(entry => entry.id))).toBe(4);

    // Reuse the same profile so Chrome must recover the persistent
    // registrations and storage state through a genuine browser restart.
    await browserContext.close();
    browserContext = null;

    restartedContext = await launch();
    let [restartedWorker] = restartedContext.serviceWorkers();
    if (!restartedWorker) restartedWorker = await restartedContext.waitForEvent('serviceworker');
    expect(restartedWorker.url().split('/')[2]).toBe(extensionId);

    const ids = seeded.registrations.map(entry => entry.id);
    const validId = seeded.registrations.find(entry => entry.pattern===validPattern).id;
    const staleIds = seeded.registrations.filter(entry => entry.pattern!==validPattern).map(entry => entry.id);

    let lastStartupSnapshot = null;
    try {
      await expect.poll(async () => {
        lastStartupSnapshot = await restartedWorker.evaluate(async values => {
          const registrations = await chrome.scripting.getRegisteredContentScripts();
          const saved = await chrome.storage.local.get({
            pageSelectionButtonSites:{},
            doubleClickBlbSites:{},
            pendingSiteFeatureToggles:{},
            siteFeaturePreferenceRequestIds:{}
          });
          const validTab = {url:values.validPattern.replace(/\\*$/, '')};
          return {
            registeredIds:registrations.filter(entry => values.ids.includes(entry.id)).map(entry => entry.id).sort(),
            validHostPermission:await chrome.permissions.contains({origins:[values.validPattern]}),
            validEligible:await shouldInjectContentScriptForTab(validTab,saved),
            validFiles:contentScriptFilesForTab(validTab,saved),
            allRuntimeRegistrations:registrations.filter(entry => entry.id.startsWith('blb-suite-runtime-')).map(entry => ({id:entry.id,matches:entry.matches})),
            pagePreference:saved.pageSelectionButtonSites['dailyverses.net'],
            expiredPendingPresent:Object.prototype.hasOwnProperty.call(saved.pendingSiteFeatureToggles,values.expiredPattern),
            validPendingPresent:Object.prototype.hasOwnProperty.call(saved.pendingSiteFeatureToggles,values.validPattern),
            missingPending:saved.pendingSiteFeatureToggles[values.missingPermissionPattern],
            expiredRequestPresent:Object.prototype.hasOwnProperty.call(saved.siteFeaturePreferenceRequestIds,values.expiredRequestKey),
            validRequestId:saved.siteFeaturePreferenceRequestIds[values.validRequestKey],
            missingRequestId:saved.siteFeaturePreferenceRequestIds[values.missingRequestKey]
          };
        },{
          ids,validPattern,expiredPattern,missingPermissionPattern,
          expiredRequestKey,validRequestKey,missingRequestKey
        });
        return lastStartupSnapshot;
      },{timeout:15000,intervals:[100,250,500,1000]}).toMatchObject({
      registeredIds:[validId],
      pagePreference:true,
      expiredPendingPresent:false,
      validPendingPresent:false,
      missingPending:{
        feature:'pageButton',
        requestedAt:expect.any(Number),
        requestId:missingRequestId
      },
      expiredRequestPresent:false,
      validRequestId,
      missingRequestId
      });
    } catch (error) {
      throw new Error(
        'Mixed permission startup diagnostics: ' + JSON.stringify(lastStartupSnapshot, null, 2),
        {cause:error}
      );
    }

    const finalRegistrations = await restartedWorker.evaluate(async idsToCheck => {
      const registered = await chrome.scripting.getRegisteredContentScripts();
      return registered.filter(entry => idsToCheck.includes(entry.id)).map(entry => entry.id);
    },ids);
    expect(finalRegistrations).toEqual([validId]);
    expect(staleIds).toHaveLength(3);
  } finally {
    await restartedContext?.close().catch(() => {});
    await browserContext?.close().catch(() => {});
    fs.rmSync(profilePath,{recursive:true,force:true});
  }
});



test('startup registration reconciliation remains correct when tabs open and navigate across mixed permission states', async ({
  context, extensionStorage, extensionWorker
}) => {
  const permittedPattern = 'https://example.com/*';
  const deniedPattern = 'https://www.wikipedia.org/*';
  const permittedUrl = 'https://example.com/';
  const deniedUrl = 'https://www.wikipedia.org/';
  const registrationId = await extensionWorker.evaluate(pattern => runtimeContentScriptIdForPattern(pattern), permittedPattern);

  // example.com is a required fixture permission; wikipedia.org is
  // deliberately outside its optional host grants, giving this test a real
  // no-permission tab without attempting to remove a required permission.
  expect(await extensionWorker.evaluate(async pattern =>
    chrome.permissions.contains({origins:[pattern]})
  , permittedPattern)).toBe(true);
  expect(await extensionWorker.evaluate(async pattern =>
    chrome.permissions.contains({origins:[pattern]})
  , deniedPattern)).toBe(false);

  // Prevent the preference write's ordinary storage listener from completing
  // activation before the test installs its registration gate.
  await extensionWorker.evaluate(async () => {
    globalThis.__multiTabStartupOriginalReconcile = reconcileRuntimeContentScriptRegistrations;
    globalThis.__multiTabStartupOriginalInject = injectConfiguredTabsAfterExtensionUpdate;
    reconcileRuntimeContentScriptRegistrations = async () => {};
    injectConfiguredTabsAfterExtensionUpdate = async () => ({eligibleTabIds:[],activatedTabIds:[],failedTabIds:[]});
    await chrome.storage.local.set({
      masterEnabled:true,
      redirectEnabled:false,
      pageSelectionButtonSites:{
        'example.com':true
      },
      doubleClickBlbSites:{}
    });
    reconcileRuntimeContentScriptRegistrations = globalThis.__multiTabStartupOriginalReconcile;
    injectConfiguredTabsAfterExtensionUpdate = globalThis.__multiTabStartupOriginalInject;
    delete globalThis.__multiTabStartupOriginalReconcile;
    delete globalThis.__multiTabStartupOriginalInject;
    await unregisterRuntimeContentScriptForPattern('https://example.com/*');
  });

  let firstPage;
  let secondPage;
  let deniedPage;
  try {
    firstPage = await context.newPage();
    secondPage = await context.newPage();
    deniedPage = await context.newPage();

    await extensionWorker.evaluate(pattern => {
      const api = chrome.scripting;
      const original = api.registerContentScripts;
      let release;
      let entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      api.registerContentScripts = async function(scripts) {
        if ((scripts || []).some(script => (script.matches || []).includes(pattern))) {
          entered();
          await gate;
        }
        return original.call(api, scripts);
      };
      globalThis.__multiTabStartupRegistrationGate = {
        started, release:() => release(), restore:() => { api.registerContentScripts = original; }
      };
    }, permittedPattern);

    // Explicitly begin the startup-style reconciliation and pause its
    // registration operation. Navigations in both already-open and newly
    // opened tabs must queue behind that operation instead of racing it.
    const reconciliationStarted = await extensionWorker.evaluate(() => {
      globalThis.__multiTabStartupRecoveryPromise = recoverConfiguredTabsOnStartup().catch(error => {
        globalThis.__multiTabStartupReconciliationError = String(error);
        throw error;
      });
      return true;
    });
    expect(reconciliationStarted).toBe(true);
    await extensionWorker.evaluate(() => globalThis.__multiTabStartupRegistrationGate.started);

    await Promise.all([
      firstPage.goto(permittedUrl, {waitUntil:'domcontentloaded'}),
      secondPage.goto(permittedUrl, {waitUntil:'domcontentloaded'}),
      deniedPage.goto(deniedUrl, {waitUntil:'domcontentloaded'}).catch(() => {})
    ]);

    await extensionWorker.evaluate(() => globalThis.__multiTabStartupRegistrationGate.release());
    await extensionWorker.evaluate(async () => {
      // Await the startup recovery that was started before the tab
      // navigations, so the registration gate overlaps the real orchestration.
      await globalThis.__multiTabStartupRecoveryPromise;
      delete globalThis.__multiTabStartupRecoveryPromise;
      if (globalThis.__multiTabStartupReconciliationError) {
        throw new Error(globalThis.__multiTabStartupReconciliationError);
      }
    });

    const state = await extensionWorker.evaluate(async ({registrationId,permittedPattern,deniedPattern}) => {
      const registrations = await chrome.scripting.getRegisteredContentScripts();
      const tabs = await chrome.tabs.query({});
      const inspect = async tab => {
        if (!tab?.id || !/^https?:/.test(tab.url || '')) return null;
        try {
          const [{result}] = await chrome.scripting.executeScript({
            target:{tabId:tab.id},
            world:'ISOLATED',
            func:() => Boolean(window.__blbSuiteContentScriptFileExecutedV3)
          });
          return {url:tab.url,loaded:result === true};
        } catch (_) {
          return {url:tab.url,loaded:false};
        }
      };
      const inspected = await Promise.all(tabs.filter(tab =>
        tab.url?.startsWith('https://example.com/') || tab.url?.startsWith('https://www.wikipedia.org/')
      ).map(inspect));
      return {
        registration:registrations.find(entry => entry.id === registrationId) || null,
        permitted:await chrome.permissions.contains({origins:[permittedPattern]}),
        denied:await chrome.permissions.contains({origins:[deniedPattern]}),
        tabs:inspected
      };
    }, {registrationId,permittedPattern,deniedPattern});

    expect(state.permitted).toBe(true);
    expect(state.denied).toBe(false);
    expect(state.registration?.matches).toContain(permittedPattern);
    expect(state.tabs.filter(tab => tab?.url?.startsWith(permittedUrl) && tab.loaded).length).toBeGreaterThanOrEqual(2);
    expect(state.tabs.filter(tab => tab?.url?.startsWith(deniedUrl) && tab.loaded)).toEqual([]);
  } finally {
    await extensionWorker.evaluate(() => {
      const gate = globalThis.__multiTabStartupRegistrationGate;
      gate?.release();
      gate?.restore();
      delete globalThis.__multiTabStartupRegistrationGate;
    }).catch(() => {});
    await Promise.all([firstPage,secondPage,deniedPage].filter(Boolean).map(page => page.close().catch(() => {})));
    await extensionWorker.evaluate(async pattern => {
      await chrome.storage.local.set({
        pageSelectionButtonSites:{'example.com':false},
        doubleClickBlbSites:{}
      });
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
      await unregisterRuntimeContentScriptForPattern(pattern).catch(() => {});
    }, permittedPattern).catch(() => {});
  }
});


test('startup recovery includes tabs created after registration reconciliation has started', async ({
  context, extensionStorage, extensionWorker
}) => {
  const pattern = 'https://example.com/*';
  const url = 'https://example.com/';
  // Create the initial matching tab while the feature is disabled. Once
  // startup recovery begins, its registration attempt is guaranteed to reach
  // the gate before a second matching tab is created.
  const firstPage = await context.newPage();
  await firstPage.goto(url,{waitUntil:'domcontentloaded'});
  let secondPage;
  await extensionStorage.set({
    masterEnabled:true,redirectEnabled:false,
    pageSelectionButtonSites:{'example.com':true},doubleClickBlbSites:{}
  });
  await extensionWorker.evaluate(async value => {
    await unregisterRuntimeContentScriptForPattern(value);
    const api = chrome.scripting;
    const original = api.registerContentScripts;
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    api.registerContentScripts = async function(scripts) {
      if ((scripts || []).some(script => (script.matches || []).includes(value))) {
        entered();
        await gate;
      }
      return original.call(api, scripts);
    };
    globalThis.__createdDuringStartupGate = {
      started, release:() => release(),
      restore:() => { api.registerContentScripts = original; }
    };
  },pattern);
  try {
    await extensionWorker.evaluate(() => {
      globalThis.__createdDuringStartupRecovery = recoverConfiguredTabsOnStartup();
      return true;
    });
    await extensionWorker.evaluate(() => globalThis.__createdDuringStartupGate.started);
    // This tab is created only after the real registration attempt is held.
    secondPage = await context.newPage();
    await secondPage.goto(url,{waitUntil:'domcontentloaded'});
    await extensionWorker.evaluate(() => globalThis.__createdDuringStartupGate.release());
    await extensionWorker.evaluate(async () => {
      await globalThis.__createdDuringStartupRecovery;
      delete globalThis.__createdDuringStartupRecovery;
    });
    const loaded = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({url:'https://example.com/*'});
      const results = await Promise.all(tabs.map(async tab => {
        if (!tab?.id) return false;
        try {
          const [{result}] = await chrome.scripting.executeScript({
            target:{tabId:tab.id},world:'ISOLATED',
            func:() => Boolean(window.__blbSuiteContentScriptFileExecutedV3)
          });
          return result === true;
        } catch (_) { return false; }
      }));
      return results;
    });
    expect(loaded.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  } finally {
    await extensionWorker.evaluate(() => {
      globalThis.__createdDuringStartupGate?.release();
      globalThis.__createdDuringStartupGate?.restore();
      delete globalThis.__createdDuringStartupGate;
      delete globalThis.__createdDuringStartupRecovery;
    }).catch(() => {});
    await Promise.all([firstPage,secondPage].filter(Boolean).map(page => page.close().catch(() => {})));
    await extensionWorker.evaluate(async pattern => {
      await chrome.storage.local.set({
        pageSelectionButtonSites:{'example.com':false},
        doubleClickBlbSites:{}
      });
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
      await unregisterRuntimeContentScriptForPattern(pattern).catch(() => {});
    }, pattern).catch(() => {});
  }
});

test('a tab closed during asynchronous eligibility checks is not injected during startup recovery', async ({
  context, extensionStorage, extensionWorker
}) => {
  const pattern = 'https://example.com/*';
  await extensionStorage.set({
    masterEnabled:true,redirectEnabled:false,
    // Keep navigation from starting an activation before the eligibility gate.
    pageSelectionButtonSites:{'example.com':false},doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  let installed = false;
  try {
    const tabId = await extensionWorker.evaluate(() =>
      chrome.tabs.query({url:'https://example.com/*'}).then(tabs => tabs[0]?.id)
    );
    expect(tabId).toBeTruthy();
    await extensionWorker.evaluate(id => {
      const original = shouldInjectContentScriptForTab;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let first = true;
      globalThis.__closedTabEligibilityGate = {
        started:false,
        release:() => release(),
        restore:() => { shouldInjectContentScriptForTab = original; }
      };
      shouldInjectContentScriptForTab = async (tab, data) => {
        if (first && tab?.id === id) {
          first = false;
          globalThis.__closedTabEligibilityGate.started = true;
          await gate;
        }
        return original(tab,data);
      };
    },tabId);
    installed = true;
    await extensionStorage.set({pageSelectionButtonSites:{'example.com':true}});
    await extensionWorker.evaluate(id => {
      globalThis.__closedTabActivationPromise = ensureContentScriptInTab(id);
      return true;
    },tabId);
    await expect.poll(() =>
      extensionWorker.evaluate(() => globalThis.__closedTabEligibilityGate?.started === true)
    ).toBe(true);
    await page.close();
    await extensionWorker.evaluate(() => globalThis.__closedTabEligibilityGate.release());
    expect(await extensionWorker.evaluate(() => globalThis.__closedTabActivationPromise)).toBe(false);
    await extensionWorker.evaluate(() => { delete globalThis.__closedTabActivationPromise; });
  } finally {
    if (installed) await extensionWorker.evaluate(() => {
      globalThis.__closedTabEligibilityGate?.release();
      globalThis.__closedTabEligibilityGate?.restore();
      delete globalThis.__closedTabEligibilityGate;
    }).catch(() => {});
    await extensionWorker.evaluate(async value => {
      await chrome.storage.local.set({pageSelectionButtonSites:{'example.com':false}});
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
      await unregisterRuntimeContentScriptForPattern(value).catch(() => {});
    },pattern).catch(() => {});
  }
});


test('a redirect during eligibility checks cannot inject the previous host bundle into the new document', async ({
  context, extensionStorage, extensionWorker
}) => {
  const permittedPattern = 'https://example.com/*';
  const deniedPattern = 'https://www.wikipedia.org/*';
  await extensionStorage.set({
    masterEnabled:true,redirectEnabled:false,
    // Prevent navigation-time activation from completing before the gate exists.
    pageSelectionButtonSites:{'example.com':false},doubleClickBlbSites:{}
  });
  const page = await context.newPage();
  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  let installed = false;
  try {
    const tabId = await extensionWorker.evaluate(() =>
      chrome.tabs.query({}).then(tabs => tabs.find(tab => {
        try { return new URL(tab.url || '').hostname === 'example.com'; }
        catch (_) { return false; }
      })?.id)
    );
    expect(tabId).toBeDefined();
    // Let any navigation-time activation started while the site was disabled
    // finish before installing the gate, so this test owns the in-flight lock.
    await expect.poll(() => extensionWorker.evaluate(id =>
      !contentScriptInjectionLocks.has(id),tabId
    ),{timeout:10000,intervals:[50,100,250,500]}).toBe(true);
    await extensionWorker.evaluate(id => {
      const original = shouldInjectContentScriptForTab;
      const originalGet = chrome.tabs.get.bind(chrome.tabs);
      const originalSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
      const originalExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let first = true;
      globalThis.__redirectTabActivationTrace = [];
      chrome.tabs.get = async tabId => {
        const tab = await originalGet(tabId);
        if (tabId === id) globalThis.__redirectTabActivationTrace.push({
          event:'tabs.get',url:tab?.url || '',pendingUrl:tab?.pendingUrl || ''
        });
        return tab;
      };
      chrome.tabs.sendMessage = async (tabId,message,...args) => {
        const response = await originalSendMessage(tabId,message,...args);
        if (tabId === id) globalThis.__redirectTabActivationTrace.push({
          event:'tabs.sendMessage',type:message?.type || '',response:response || null
        });
        return response;
      };
      chrome.scripting.executeScript = async details => {
        if (details?.target?.tabId === id) globalThis.__redirectTabActivationTrace.push({
          event:'executeScript',files:details.files || [],world:details.world || 'ISOLATED'
        });
        return originalExecuteScript(details);
      };
      globalThis.__redirectTabEligibilityGate = {
        started:false, enteredUrl:'', eligibilityResult:null,
        release:() => release(), restore:() => {
          shouldInjectContentScriptForTab = original;
          chrome.tabs.get = originalGet;
          chrome.tabs.sendMessage = originalSendMessage;
          chrome.scripting.executeScript = originalExecuteScript;
        }
      };
      shouldInjectContentScriptForTab = async (tab,data) => {
        if (first && tab?.id === id) {
          first = false;
          globalThis.__redirectTabEligibilityGate.started = true;
          globalThis.__redirectTabEligibilityGate.enteredUrl = tab?.url || '';
          await gate;
        }
        const result = await original(tab,data);
        if (tab?.id === id) globalThis.__redirectTabEligibilityGate.eligibilityResult = result;
        return result;
      };
    },tabId);
    installed = true;
    // Match the closed-tab race test: install the gate before enabling the site.
    await extensionStorage.set({pageSelectionButtonSites:{'example.com':true}});
    await extensionWorker.evaluate(id => {
      globalThis.__redirectTabActivationPromise = ensureContentScriptInTab(id);
      return true;
    },tabId);
    await expect.poll(() =>
      extensionWorker.evaluate(() => globalThis.__redirectTabEligibilityGate?.started === true)
    ).toBe(true);
    await page.goto('https://www.wikipedia.org/',{waitUntil:'domcontentloaded'}).catch(() => {});
    // Playwright's navigation completion can precede Chrome's tabs API URL
    // update. Do not release eligibility until the worker sees the new host.
    await expect.poll(() => extensionWorker.evaluate(async id => {
      try { return (await chrome.tabs.get(id)).url || ''; }
      catch (_) { return ''; }
    },tabId),{timeout:10000,intervals:[50,100,250,500]}).toContain('wikipedia.org');
    await extensionWorker.evaluate(() => globalThis.__redirectTabEligibilityGate.release());
    const activationDiagnostics = await extensionWorker.evaluate(async id => ({
      activationResult:await globalThis.__redirectTabActivationPromise,
      gate:{...globalThis.__redirectTabEligibilityGate,release:undefined,restore:undefined},
      trace:[...(globalThis.__redirectTabActivationTrace || [])],
      currentTabUrl:(await chrome.tabs.get(id)).url
    }),tabId);
    expect(activationDiagnostics, 'Redirect activation diagnostics: ' + JSON.stringify(activationDiagnostics)).toMatchObject({activationResult:false});
    await extensionWorker.evaluate(() => { delete globalThis.__redirectTabActivationPromise; });
    const redirectedTab = await extensionWorker.evaluate(async id => {
      const current = await chrome.tabs.get(id);
      return current?.url || '';
    },tabId);
    expect(redirectedTab).toContain('wikipedia.org');
    expect(await extensionWorker.evaluate(pattern =>
      chrome.permissions.contains({origins:[pattern]}),deniedPattern)).toBe(false);
  } finally {
    if (installed) await extensionWorker.evaluate(() => {
      globalThis.__redirectTabEligibilityGate?.release();
      globalThis.__redirectTabEligibilityGate?.restore();
      delete globalThis.__redirectTabEligibilityGate;
    }).catch(() => {});
    await page.close().catch(() => {});
    await extensionWorker.evaluate(async value => {
      await chrome.storage.local.set({pageSelectionButtonSites:{'example.com':false}});
      await reconcileRuntimeContentScriptRegistrations().catch(() => {});
      await unregisterRuntimeContentScriptForPattern(value).catch(() => {});
    },permittedPattern).catch(() => {});
  }
});


test('a real pending site-permission cleanup alarm wakes a terminated MV3 worker and prunes only expired feature intents', async ({
  context, extensionId, extensionWorker
}) => {
  // Chrome enforces a minimum alarm delay. The first intent expires in 65s;
  // a second feature remains valid so the alarm must reschedule itself.
  test.setTimeout(150000);
  const origin = 'https://ungranted-pending-cleanup.example/*';
  const expiredOrigin = 'https://expired-matching-cleanup.example/*';
  const futureOrigin = 'https://future-dated-cleanup.example/*';
  const pageRequestKey = origin + '|pageButton';
  const doubleClickRequestKey = origin + '|doubleClick';
  const expiredRequestKey = expiredOrigin + '|pageButton';
  const futureRequestKey = futureOrigin + '|pageButton';
  const currentRequestId = 'real-alarm-current-double-click';
  const newerRequestId = 'real-alarm-newer-page-button-request';
  const previous = await extensionWorker.evaluate(() => chrome.storage.local.get({
    pendingSiteFeatureToggles:{},
    siteFeaturePreferenceRequestIds:{}
  }));
  const previousAlarm = await extensionWorker.evaluate(() =>
    chrome.alarms.get('site-feature-permission-pending-cleanup')
  );
  await extensionWorker.evaluate(async value => {
    const now = Date.now();
    const expiredAt = now - SITE_FEATURE_PERMISSION_PENDING_TTL_MS + 65000;
    const currentAt = now;
    const expiredOrigin = 'https://expired-matching-cleanup.example/*';
    const futureOrigin = 'https://future-dated-cleanup.example/*';
    await chrome.storage.local.set({
      pendingSiteFeatureToggles:{
        [value]:{
          features:{
            pageButton:{requestedAt:expiredAt,requestId:'real-alarm-expired-page-button'},
            doubleClick:{requestedAt:currentAt,requestId:'real-alarm-current-double-click'}
          }
        },
        [expiredOrigin]:{
          feature:'pageButton',
          requestedAt:expiredAt,
          requestId:'real-alarm-matching-expired-request'
        },
        [futureOrigin]:{
          feature:'pageButton',
          requestedAt:now + 120000,
          requestId:'real-alarm-future-dated-request'
        }
      },
      siteFeaturePreferenceRequestIds:{
        [value + '|pageButton']:'real-alarm-newer-page-button-request',
        [value + '|doubleClick']:'real-alarm-current-double-click',
        [expiredOrigin + '|pageButton']:'real-alarm-matching-expired-request',
        [futureOrigin + '|pageButton']:'real-alarm-future-dated-request'
      }
    });
    await schedulePendingSiteFeatureToggleCleanup();
    return {expiredAt,currentAt};
  }, origin);
  expect(await extensionWorker.evaluate(value =>
    chrome.permissions.contains({origins:[value]}) , origin)).toBe(false);
  const alarm = await extensionWorker.evaluate(() =>
    chrome.alarms.get(SITE_FEATURE_PERMISSION_PENDING_CLEANUP_ALARM)
  );
  expect(alarm).toBeTruthy();
  expect(alarm.scheduledTime).toBeGreaterThan(Date.now());

  const browser = context.browser();
  expect(browser, 'persistent context must expose its Chromium browser').not.toBeNull();
  const cdp = await browser.newBrowserCDPSession();
  let observer;
  let cleanupPage;
  try {
    await cdp.send('Target.setDiscoverTargets', {discover:true});
    const {targetInfos} = await cdp.send('Target.getTargets');
    const workerTarget = targetInfos.find(target =>
      target.type === 'service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    expect(workerTarget, 'extension service-worker target must be discoverable').toBeTruthy();

    const closed = await cdp.send('Target.closeTarget', {targetId:workerTarget.targetId});
    expect(closed.success).toBe(true);
    await expect.poll(async () => {
      const {targetInfos:currentTargets} = await cdp.send('Target.getTargets');
      return currentTargets.some(target => target.targetId === workerTarget.targetId);
    }, {timeout:5000}).toBe(false);

    // No extension page is opened during the wait. The later storage-only
    // observer verifies the alarm handler's result without waking the worker
    // through a runtime message.
    await new Promise(resolve => setTimeout(resolve, 70000));
    observer = await context.newPage();
    await observer.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect.poll(() => observer.evaluate(async ({origin,expiredOrigin,futureOrigin,pageRequestKey,doubleClickRequestKey,expiredRequestKey,futureRequestKey}) => {
      const data = await chrome.storage.local.get({
        pendingSiteFeatureToggles:{},
        siteFeaturePreferenceRequestIds:{}
      });
      const remaining = data.pendingSiteFeatureToggles[origin];
      return {
        remainingFeatures:remaining?.features ?? remaining ?? null,
        expiredOriginPresent:Object.prototype.hasOwnProperty.call(data.pendingSiteFeatureToggles,expiredOrigin),
        futureOriginPresent:Object.prototype.hasOwnProperty.call(data.pendingSiteFeatureToggles,futureOrigin),
        futureRequestId:data.siteFeaturePreferenceRequestIds[futureRequestKey] ?? null,
        newerPageRequestId:data.siteFeaturePreferenceRequestIds[pageRequestKey] ?? null,
        currentDoubleClickRequestId:data.siteFeaturePreferenceRequestIds[doubleClickRequestKey] ?? null,
        matchingExpiredRequestId:data.siteFeaturePreferenceRequestIds[expiredRequestKey] ?? null
      };
    }, {origin,expiredOrigin,futureOrigin,pageRequestKey,doubleClickRequestKey,expiredRequestKey,futureRequestKey}), {
      timeout:15000,intervals:[250,500,1000]
    }).toEqual({
      remainingFeatures:{
        feature:'doubleClick',
        requestedAt:expect.any(Number),
        requestId:currentRequestId
      },
      expiredOriginPresent:false,
      futureOriginPresent:false,
      futureRequestId:null,
      newerPageRequestId:newerRequestId,
      currentDoubleClickRequestId:currentRequestId,
      matchingExpiredRequestId:null
    });

    const rescheduledAlarm = await observer.evaluate(() =>
      chrome.alarms.get('site-feature-permission-pending-cleanup')
    );
    expect(rescheduledAlarm, 'the remaining valid intent must retain a cleanup alarm').toBeTruthy();
    expect(rescheduledAlarm.scheduledTime).toBeGreaterThan(Date.now() + 120000);
  } finally {
    await cdp.detach().catch(() => {});
    cleanupPage = observer || await context.newPage().catch(() => null);
    if (cleanupPage) {
      if (!observer) await cleanupPage.goto(`chrome-extension://${extensionId}/popup.html`).catch(() => {});
      await cleanupPage.evaluate(async ({previous,previousAlarm}) => {
        await chrome.storage.local.set(previous);
        if (previousAlarm) {
          await chrome.alarms.create('site-feature-permission-pending-cleanup',{when:previousAlarm.scheduledTime});
        } else {
          await chrome.alarms.clear('site-feature-permission-pending-cleanup');
        }
      }, {previous,previousAlarm}).catch(() => {});
      if (cleanupPage !== observer) await cleanupPage.close().catch(() => {});
    }
    await observer?.close().catch(() => {});
  }
});

// First-load and destination-tab readiness regressions.


async function getTabIdForUrl(extensionWorker, urlPattern) {
  return extensionWorker.evaluate(async pattern => {
    const tabs = await chrome.tabs.query({url:pattern});
    return tabs.find(tab => Number.isInteger(tab.id))?.id ?? null;
  }, urlPattern);
}

async function contentScriptLoaded(extensionWorker, tabId) {
  return extensionWorker.evaluate(async id => {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target:{tabId:id},
        world:'ISOLATED',
        func:() => ({
          fileExecuted:window.__blbSuiteContentScriptFileExecutedV3 === true,
          initialized:window.__blbSuiteContentScriptLoadedV2 === true,
          doubleClickBound:typeof window.__blbSuiteDoubleClickBoundV2 === 'function'
        })
      });
      return injection?.result || null;
    } catch (_) {
      return null;
    }
  }, tabId);
}

async function hasBlbPassage(extensionWorker, path) {
  return extensionWorker.evaluate(async expectedPath => {
    const tabs = await chrome.tabs.query({});
    return tabs.some(tab => {
      try {
        const url = new URL(tab.pendingUrl || tab.url || '');
        return url.hostname === 'www.blueletterbible.org' &&
          url.pathname.replace(/\/+$/, '/') === expectedPath;
      } catch (_) {
        return false;
      }
    });
  }, path);
}

async function closeBlbTabs(extensionWorker) {
  await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({url:'https://www.blueletterbible.org/*'});
    await Promise.all(tabs.map(tab =>
      Number.isInteger(tab.id) ? chrome.tabs.remove(tab.id).catch(() => {}) : Promise.resolve()
    ));
  });
}

test('first X.com document activates Floating Button and Double-click without a manual reload', async ({
  page, extensionStorage, extensionWorker
}) => {
  await closeBlbTabs(extensionWorker);
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'x.com':false},
    doubleClickBlbSites:{'x.com':false}
  });
  await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations());
  await extensionStorage.set({
    pageSelectionButtonSites:{'x.com':true},
    doubleClickBlbSites:{'x.com':true}
  });

  // Keep the test deterministic while retaining the real x.com origin,
  // optional-host permission check, runtime registration, and tabs.onUpdated
  // current-document injection path.
  await page.route('https://x.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>X first-load regression</title></head><body><p id="reference">John 3:16</p></body></html>'
  }));
  await page.goto('https://x.com/', {waitUntil:'domcontentloaded'});

  const tabId = await getTabIdForUrl(extensionWorker, 'https://x.com/*');
  expect(Number.isInteger(tabId)).toBe(true);

  await expect.poll(() => contentScriptLoaded(extensionWorker, tabId), {
    message:'the first x.com document must receive and initialize the runtime bundle, including the Double-click handler, without reloading'
  }).toMatchObject({fileExecuted:true, initialized:true, doubleClickBound:true});

  // Exercise the actual floating action on the first document.
  await page.evaluate(() => {
    const target = document.querySelector('#reference');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
  });
  const floatingButton = page.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible();
  await floatingButton.click();
  await expect.poll(() => hasBlbPassage(extensionWorker, '/kjv/jhn/3/16/')).toBe(true);

  // The Floating Button opens and activates a BLB tab; return to the original
  // x.com document before exercising Double-click on that same document.
  await page.bringToFront();
  await page.evaluate(() => {
    const target = document.querySelector('#reference');
    target.innerHTML = 'Romans 8:<span id="verse-number">28</span>';
  });
  await page.locator('#verse-number').dblclick();
  await expect.poll(() => hasBlbPassage(extensionWorker, '/kjv/rom/8/28/')).toBe(true);

  expect(await contentScriptLoaded(extensionWorker, tabId)).toMatchObject({
    fileExecuted:true,
    initialized:true
  });

  await closeBlbTabs(extensionWorker);
  await extensionStorage.set({
    pageSelectionButtonSites:{'x.com':false},
    doubleClickBlbSites:{'x.com':false}
  });
  await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations());
});

test('an already-open X.com document activates Floating Button and Double-click after site opt-in without a reload', async ({
  page, extensionStorage, extensionWorker
}) => {
  await closeBlbTabs(extensionWorker);
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'x.com':false},
    doubleClickBlbSites:{'x.com':false}
  });
  await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations());

  await page.route('https://x.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>X.com live activation regression</title></head><body><p id="reference">John 3:16</p></body></html>'
  }));
  await page.goto('https://x.com/', {waitUntil:'domcontentloaded'});
  const tabId = await getTabIdForUrl(extensionWorker, 'https://x.com/*');
  expect(Number.isInteger(tabId)).toBe(true);

  await page.evaluate(() => { window.__blbSameDocumentActivationToken = 'same-x-com-document'; });
  await expect.poll(() => contentScriptLoaded(extensionWorker, tabId)).toMatchObject({
    fileExecuted:false,
    initialized:false,
    doubleClickBound:false
  });

  // Enable both features after the page has already loaded. The storage-change
  // activation path must inject and initialize into this existing document.
  await extensionStorage.set({
    pageSelectionButtonSites:{'x.com':true},
    doubleClickBlbSites:{'x.com':true}
  });
  await expect.poll(() => contentScriptLoaded(extensionWorker, tabId), {
    message:'enabling X.com features must activate the existing document without a page reload'
  }).toMatchObject({fileExecuted:true, initialized:true, doubleClickBound:true});

  await page.evaluate(() => {
    const target = document.querySelector('#reference');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
  });
  const floatingButton = page.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible();
  await floatingButton.click();
  await expect.poll(() => hasBlbPassage(extensionWorker, '/kjv/jhn/3/16/')).toBe(true);

  await page.bringToFront();
  await page.evaluate(() => {
    document.querySelector('#reference').innerHTML = 'Romans 8:<span id="verse-number">28</span>';
  });
  await page.locator('#verse-number').dblclick();
  await expect.poll(() => hasBlbPassage(extensionWorker, '/kjv/rom/8/28/')).toBe(true);
  expect(await page.evaluate(() => window.__blbSameDocumentActivationToken))
    .toBe('same-x-com-document');

  await closeBlbTabs(extensionWorker);
  await extensionStorage.set({
    pageSelectionButtonSites:{'x.com':false},
    doubleClickBlbSites:{'x.com':false}
  });
  await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations());
});

test('a BLB verse link opened in a new tab activates passive targets on the first load', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true});
  await context.route('https://www.blueletterbible.org/**', route => {
    const url = new URL(route.request().url());
    const body = url.pathname.toLowerCase() === '/kjv/rom/8/28/'
      ? '<!doctype html><html><head><title>BLB destination</title></head><body><a id="next-verse" href="https://www.blueletterbible.org/kjv/1co/13/4/">1 Corinthians 13:4</a></body></html>'
      : '<!doctype html><html><head><title>BLB source</title></head><body><a id="new-tab-verse" href="https://www.blueletterbible.org/kjv/rom/8/28/">Romans 8:28</a></body></html>';
    return route.fulfill({status:200,contentType:'text/html',body});
  });

  await page.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', {waitUntil:'domcontentloaded'});
  // The extension, rather than the fixture, must apply the new-tab behavior.
  await expect(page.locator('#new-tab-verse')).toHaveAttribute('target','_blank');
  const popupPromise = context.waitForEvent('page');
  await page.locator('#new-tab-verse').click();
  const newTab = await popupPromise;
  await newTab.waitForLoadState('domcontentloaded');

  const newTabId = await getTabIdForUrl(
    extensionWorker,
    'https://www.blueletterbible.org/kjv/rom/8/28/*'
  );
  expect(Number.isInteger(newTabId)).toBe(true);

  await expect.poll(() => contentScriptLoaded(extensionWorker, newTabId), {
    message:'a BLB destination opened in a new tab must initialize the extension without a manual reload'
  }).toMatchObject({fileExecuted:true, initialized:true});

  // The new document must also activate the passive-target module immediately.
  await expect(newTab.locator('#next-verse')).toHaveAttribute('target','_blank');
  expect(newTab.url()).toContain('/kjv/rom/8/28/');

  // Follow a verse link from that newly opened tab. It must open and initialize
  // a second destination tab on its first load as well.
  const secondPopupPromise = context.waitForEvent('page');
  await newTab.locator('#next-verse').click();
  const secondTab = await secondPopupPromise;
  await secondTab.waitForLoadState('domcontentloaded');
  expect(secondTab.url()).toContain('/kjv/1co/13/4/');
  const secondTabId = await getTabIdForUrl(
    extensionWorker,
    'https://www.blueletterbible.org/kjv/1co/13/4/*'
  );
  expect(Number.isInteger(secondTabId)).toBe(true);
  await expect.poll(() => contentScriptLoaded(extensionWorker, secondTabId), {
    message:'a second-level BLB destination tab must initialize without a manual reload'
  }).toMatchObject({fileExecuted:true, initialized:true});
  await expect(secondTab.locator('#new-tab-verse')).toHaveAttribute('target','_blank');

  await closeBlbTabs(extensionWorker);
});

test('a MultiVerse link opened from BLB in a new tab defaults to Tool View on first load', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true});
  await context.route('https://www.blueletterbible.org/**', route => {
    const url = new URL(route.request().url());
    const body = url.pathname.toLowerCase() === '/tools/multiverse.cfm'
      ? '<!doctype html><html><head><title>MultiVerse destination</title></head><body><button id="formatButton" class="byVerseResults">Tool View</button><script>document.querySelector("#formatButton").addEventListener("click",function(){this.className=this.classList.contains("byVerseResults")?"multiVerseResults":"byVerseResults";});</script></body></html>'
      : '<!doctype html><html><head><title>BLB source</title></head><body><a id="open-multiverse" target="_blank" href="https://www.blueletterbible.org/tools/MultiVerse.cfm">Open MultiVerse</a></body></html>';
    return route.fulfill({status:200,contentType:'text/html',body});
  });

  await page.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', {waitUntil:'domcontentloaded'});
  const popupPromise = context.waitForEvent('page');
  await page.locator('#open-multiverse').click();
  const newTab = await popupPromise;
  await newTab.waitForLoadState('load');
  await expect(newTab.locator('#formatButton.multiVerseResults')).toBeVisible({timeout:10000});
  await closeBlbTabs(extensionWorker);
});


test('an X.com link opened in a new tab activates Floating Button and Double-click on first load', async ({
  page, context, extensionStorage, extensionWorker
}) => {
  await closeBlbTabs(extensionWorker);
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'x.com':true},
    doubleClickBlbSites:{'x.com':true}
  });
  await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations());
  await context.route('https://x.com/**', route => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/'
      ? '<!doctype html><html><head><title>X source</title></head><body><a id="open-x-target" target="_blank" href="https://x.com/i/status/123">Open post</a></body></html>'
      : '<!doctype html><html><head><title>X destination</title></head><body><p id="x-reference">John 3:16</p></body></html>';
    return route.fulfill({status:200,contentType:'text/html',body});
  });

  await page.goto('https://x.com/', {waitUntil:'domcontentloaded'});
  const sourceTabId = await getTabIdForUrl(extensionWorker, 'https://x.com/');
  expect(Number.isInteger(sourceTabId)).toBe(true);
  await expect.poll(() => contentScriptLoaded(extensionWorker, sourceTabId)).toMatchObject({
    fileExecuted:true, initialized:true, doubleClickBound:true
  });

  const popupPromise = context.waitForEvent('page');
  await page.locator('#open-x-target').click();
  const destination = await popupPromise;
  await destination.waitForLoadState('domcontentloaded');
  const destinationTabId = await getTabIdForUrl(extensionWorker, 'https://x.com/i/status/123');
  expect(Number.isInteger(destinationTabId)).toBe(true);
  await expect.poll(() => contentScriptLoaded(extensionWorker, destinationTabId), {
    message:'the newly opened X.com destination must initialize the extension on its first document, without a reload'
  }).toMatchObject({fileExecuted:true, initialized:true, doubleClickBound:true});

  await destination.locator('#x-reference').evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  const floatingButton = destination.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible();
  await floatingButton.click();
  await expect.poll(() => hasBlbPassage(extensionWorker, '/kjv/jhn/3/16/')).toBe(true);

  await destination.bringToFront();
  await destination.locator('#x-reference').evaluate(element => {
    element.innerHTML = 'Romans 8:<span id="x-verse-number">28</span>';
  });
  await destination.locator('#x-verse-number').dblclick();
  await expect.poll(() => hasBlbPassage(extensionWorker, '/kjv/rom/8/28/')).toBe(true);

  await closeBlbTabs(extensionWorker);
  await extensionStorage.set({
    pageSelectionButtonSites:{'x.com':false},
    doubleClickBlbSites:{'x.com':false}
  });
  await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations());
});


test('generic supplyofgrace.com site opt-in activates the already-open document without reload', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{'supplyofgrace.com':false},
    doubleClickBlbSites:{'supplyofgrace.com':false}
  });
  await extensionWorker.evaluate(() => reconcileRuntimeContentScriptRegistrations());
  await page.route('https://www.supplyofgrace.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>Supply of Grace first-load fixture</title></head><body><p id="reference">John 3:16</p></body></html>'
  }));
  await page.goto('https://www.supplyofgrace.com/',{waitUntil:'domcontentloaded'});
  const tabId=await getTabIdForUrl(extensionWorker,'https://www.supplyofgrace.com/*');
  expect(Number.isInteger(tabId)).toBe(true);
  await expect.poll(() => contentScriptLoaded(extensionWorker,tabId)).toMatchObject({
    fileExecuted:false,initialized:false,doubleClickBound:false
  });

  await page.evaluate(() => { window.__supplyOfGraceDocumentToken = 'same-live-document'; });
  // Reproduce a prior tab-scoped activation still resolving when the user
  // enables this site's feature. The storage-change activation path must not
  // mistake that old promise for proof that the current document is ready.
  await extensionWorker.evaluate(id => {
    contentScriptInjectionLocks.set(id,Promise.resolve(true));
  },tabId);
  await extensionStorage.set({
    pageSelectionButtonSites:{'supplyofgrace.com':true},
    doubleClickBlbSites:{'supplyofgrace.com':false}
  });
  await expect.poll(() => contentScriptLoaded(extensionWorker,tabId),{
    message:'a generic optional-permission host must be initialized in its current document after an overlapping activation'
  }).toMatchObject({fileExecuted:true,initialized:true,doubleClickBound:false});
  await expect.poll(() => page.evaluate(() => window.__supplyOfGraceDocumentToken))
    .toBe('same-live-document');

  await page.evaluate(() => {
    const target=document.querySelector('#reference');
    const range=document.createRange();
    range.selectNodeContents(target);
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  await expect(page.locator('#blb-suite-page-selection-button')).toBeVisible();
  await page.locator('#blb-suite-page-selection-button').click();
  await expect.poll(() => hasBlbPassage(extensionWorker,'/kjv/jhn/3/16/')).toBe(true);
});
