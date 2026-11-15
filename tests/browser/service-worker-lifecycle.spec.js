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
    expect(recoveredWorker,'Floating Show on BLB must wake the extension service worker').toBeTruthy();
  } finally {
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

    const currentRef = {book:'John', chapter:3, from:16, to:16};
    const retainedRef = {book:'Acts', chapter:2, from:1, to:1};
    const migratedRef = {book:'Romans', chapter:8, from:1, to:2};
    try {
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
