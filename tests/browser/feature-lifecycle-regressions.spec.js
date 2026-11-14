const { test, expect } = require('./fixtures');

test('Study Sessions lifecycle creates a topic, edits notes, stops recording, and retains history', async ({ context, extensionId, extensionStorage }) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  const send = message => page.evaluate(value => chrome.runtime.sendMessage(value), message);
  const topic = 'BLB regression lifecycle ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');

  const started = await send({ type: 'blbSuiteStartStudyTopic', title: topic, note: 'Initial note' });
  expect(started).toMatchObject({ ok: true, recording: true, topic: normalizedTopic });

  const added = await send({ type: 'blbSuiteAddStudyNoteToTopic', topic, note: 'Second note' });
  expect(added).toMatchObject({ ok: true, topic: normalizedTopic });

  const updated = await send({ type: 'blbSuiteUpdateStudyNoteToTopic', topic, originalNote: 'Initial note', note: 'Edited initial note' });
  expect(updated).toMatchObject({ ok: true, topic: normalizedTopic });

  const active = await send({ type: 'blbSuiteGetStudyUiState' });
  expect(active).toMatchObject({
    ok: true,
    recording: true,
    currentTopic: normalizedTopic,
    currentSession: { topic: normalizedTopic, notes: 2 }
  });
  expect(active.topicStats[normalizedTopic].notes).toBe(2);

  const stopped = await send({ type: 'blbSuiteStopStudyRecording' });
  expect(stopped).toMatchObject({ ok: true, recording: false });

  const persisted = await send({ type: 'blbSuiteGetStudyUiState' });
  expect(persisted.ok).toBe(true);
  expect(persisted.recording).toBe(false);
  expect(persisted.topics).toContain(normalizedTopic);
  expect(persisted.topicStats[normalizedTopic].notes).toBe(2);

  await page.reload();
  const afterReload = await send({ type: 'blbSuiteGetStudyUiState' });
  expect(afterReload).toMatchObject({
    ok: true,
    recording: false,
    topics: expect.arrayContaining([normalizedTopic]),
    currentSession: null
  });
  expect(afterReload.topicStats[normalizedTopic].notes).toBe(2);
  await page.close();
});

test('Study Sessions reject empty topic and note input without corrupting the current session', async ({ context, extensionId, extensionStorage }) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  const send = message => page.evaluate(value => chrome.runtime.sendMessage(value), message);
  const emptyStart = await send({ type: 'blbSuiteStartStudyTopic', title: '   ', note: 'ignored' });
  expect(emptyStart).toMatchObject({ ok: false, reason: 'empty' });

  const topic = 'BLB regression empty input ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  const started = await send({ type: 'blbSuiteStartStudyTopic', title: topic });
  expect(started).toMatchObject({ ok: true, recording: true, topic: normalizedTopic });

  const emptyNote = await send({ type: 'blbSuiteAddStudyNoteToTopic', topic, note: '   ' });
  expect(emptyNote).toMatchObject({ ok: false, reason: 'empty' });

  const state = await send({ type: 'blbSuiteGetStudyUiState' });
  expect(state).toMatchObject({ ok: true, recording: true, currentTopic: normalizedTopic });
  expect(state.currentSession.notes).toBe(0);
  await page.close();
});


test('Study Sessions delete removes a topic and clears its active recording state', async ({ context, extensionId, extensionStorage }) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  const send = message => page.evaluate(value => chrome.runtime.sendMessage(value), message);
  const topic = 'BLB regression delete ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');

  const started = await send({ type: 'blbSuiteStartStudyTopic', title: topic, note: 'Delete me' });
  expect(started).toMatchObject({ ok: true, recording: true, topic: normalizedTopic });

  const deleted = await send({ type: 'blbSuiteClearStudyTopic', topic: normalizedTopic });
  expect(deleted).toMatchObject({ ok: true, topic: normalizedTopic });

  const state = await send({ type: 'blbSuiteGetStudyUiState' });
  expect(state.ok).toBe(true);
  expect(state.recording).toBe(false);
  expect(state.currentSession).toBeNull();
  expect(state.topics).not.toContain(normalizedTopic);
  expect(state.topicStats[normalizedTopic]).toBeUndefined();
  await page.close();
});


test('Study Sessions deleting an inactive topic preserves the active topic and its notes', async ({ context, extensionId, extensionStorage }) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  const send = message => page.evaluate(value => chrome.runtime.sendMessage(value), message);
  const inactiveTopic = 'BLB regression inactive topic ' + Date.now();
  const activeTopic = 'BLB regression active topic ' + Date.now();
  const titleCase = value => value.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  const inactiveTitle = titleCase(inactiveTopic);
  const activeTitle = titleCase(activeTopic);

  expect(await send({ type: 'blbSuiteStartStudyTopic', title: inactiveTopic, note: 'Inactive note' }))
    .toMatchObject({ ok: true, topic: inactiveTitle });
  expect(await send({ type: 'blbSuiteStartStudyTopic', title: activeTopic, note: 'Active note' }))
    .toMatchObject({ ok: true, topic: activeTitle, recording: true });

  expect(await send({ type: 'blbSuiteClearStudyTopic', topic: inactiveTitle }))
    .toMatchObject({ ok: true, topic: inactiveTitle });

  const state = await send({ type: 'blbSuiteGetStudyUiState' });
  expect(state).toMatchObject({
    ok: true,
    recording: true,
    currentTopic: activeTitle,
    currentSession: { topic: activeTitle, notes: 1 }
  });
  expect(state.topics).not.toContain(inactiveTitle);
  expect(state.topics).toContain(activeTitle);
  expect(state.topicStats[activeTitle].notes).toBe(1);
  await page.close();
});

test('Study Sessions confirmation cancel preserves active recording for topic-delete and delete-all actions', async ({ context, extensionId, extensionStorage, extensionWorker }) => {
  await extensionStorage.clear();
  const topic = 'BLB regression cancel deletion ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  await extensionWorker.evaluate(async value => startStudyTopicFromPopup(value, 'Keep this note'), topic);

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await page.waitForFunction(
    () => !document.body.classList.contains('popup-loading') &&
      !document.body.classList.contains('sensitive-restricted'),
    null,
    { timeout: 10000 }
  );
  await expect(page.locator('#studyTopic')).toBeVisible();
  await expect(page.locator('#studyTopic')).toBeEnabled();
  await page.evaluate(() => { window.confirm = () => false; });
  await page.locator('#studyTopic').fill(normalizedTopic);
  await expect(page.locator('#clearSelectedTopic')).toBeEnabled();

  await page.locator('#clearStudy').click();
  await page.locator('#clearSelectedTopic').click();
  let state = await extensionWorker.evaluate(() => getStudyUiState());
  expect(state).toMatchObject({ ok: true, recording: true, currentTopic: normalizedTopic });
  expect(state.topicStats[normalizedTopic].notes).toBe(1);

  await page.locator('#clearStudy').click();
  await page.locator('#clearAllTopics').click();
  state = await extensionWorker.evaluate(() => getStudyUiState());
  expect(state).toMatchObject({ ok: true, recording: true, currentTopic: normalizedTopic });
  expect(state.topicStats[normalizedTopic].notes).toBe(1);
  await page.close();
});

test('Global master OFF gates Show on BLB without erasing per-site preferences or coupling redirects', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled: true,
    redirectEnabled: false,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true }
  });

  const enabled = await extensionWorker.evaluate(async () => ({
    eligible: await isPageButtonEnabledForHostname('example.com'),
    contextMenu: await shouldShowBlbContextMenu({ url: 'https://example.com/', title: 'Example' }, 'John 3:16')
  }));
  expect(enabled).toEqual({ eligible: true, contextMenu: true });

  await extensionStorage.set({ masterEnabled: false });
  const disabled = await extensionWorker.evaluate(async () => ({
    eligible: await isPageButtonEnabledForHostname('example.com'),
    contextMenu: await shouldShowBlbContextMenu({ url: 'https://example.com/', title: 'Example' }, 'John 3:16'),
    saved: await chrome.storage.local.get({ pageSelectionButtonSites: {}, doubleClickBlbSites: {}, redirectEnabled: true })
  }));
  expect(disabled.eligible).toBe(false);
  expect(disabled.contextMenu).toBe(false);
  expect(disabled.saved.pageSelectionButtonSites['example.com']).toBe(true);
  expect(disabled.saved.doubleClickBlbSites['example.com']).toBe(true);
  expect(disabled.saved.redirectEnabled).toBe(false);

  await extensionStorage.set({ masterEnabled: true });
  const restored = await extensionWorker.evaluate(() => isPageButtonEnabledForHostname('example.com'));
  expect(restored).toBe(true);
});


test('BLB right-click eligibility follows Show on BLB for the main host but excludes BLB subdomains', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: {
      'blueletterbible.org': true,
      'tools.blueletterbible.org': true,
      'example.com': true
    }
  });

  const result = await extensionWorker.evaluate(async () => ({
    mainBlb: await shouldShowBlbContextMenu({
      url: 'https://www.blueletterbible.org/kjv/jhn/3/16/',
      title: 'Blue Letter Bible'
    }, 'John 3:16'),
    blbSubdomain: await shouldShowBlbContextMenu({
      url: 'https://tools.blueletterbible.org/kjv/jhn/3/16/',
      title: 'BLB tools'
    }, 'John 3:16'),
    externalSite: await shouldShowBlbContextMenu({
      url: 'https://example.com/',
      title: 'Example'
    }, 'John 3:16')
  }));

  expect(result).toEqual({
    mainBlb: true,
    blbSubdomain: false,
    externalSite: true
  });
});

test('a stale saved Double-click preference cannot activate Double-click on BLB pages', async ({ page, extensionStorage, extensionWorker }) => {
  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: {},
    doubleClickBlbSites: { 'blueletterbible.org': true }
  });

  // Serve a deterministic document under BLB's real origin so this checks the
  // content script's hostname gate without depending on the live BLB website.
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>BLB test page</title></head><body><p id="blb-host-double-click-target">faith</p></body></html>'
  }));
  await page.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const beforeIds = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await page.locator('#blb-host-double-click-target').dblclick();
  await page.waitForTimeout(500);

  const newTabs = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
    tabs.filter(tab => !before.includes(tab.id)).map(tab => tab.url || tab.pendingUrl || '')
  ), beforeIds);

  expect(newTabs, 'Double-click must not open a BLB search or passage tab on BLB itself').toEqual([]);
});

test('Study Sessions auto-stop respects the inactivity threshold and preserves paused topic history', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true, studyAutoStopMinutes: 5 });

  const topic = 'BLB regression auto-stop ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  const started = await extensionWorker.evaluate(value => startStudyTopicFromPopup(value, 'Keep this note'), topic);
  expect(started).toMatchObject({ ok: true, recording: true, topic: normalizedTopic });

  const sessionId = await extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ currentStudySessionId: null })).currentStudySessionId
  );

  // Just under the configured limit must not stop recording.
  await extensionStorage.set({ studyLastActivityAt: Date.now() - (5 * 60 * 1000) + 1000 });
  await extensionWorker.evaluate(() => checkStudyAutoStop());
  let state = await extensionWorker.evaluate(() => chrome.storage.local.get({
    currentStudySessionId: null, studyPauseReason: '', studyPausedTopic: ''
  }));
  expect(state.currentStudySessionId).toBe(sessionId);
  expect(state.studyPauseReason).toBe('');

  // At the inactivity limit, recording stops but the topic and notes remain.
  await extensionStorage.set({ studyLastActivityAt: Date.now() - (5 * 60 * 1000) });
  await extensionWorker.evaluate(() => checkStudyAutoStop());
  state = await extensionWorker.evaluate(() => chrome.storage.local.get({
    currentStudySessionId: null, studyPauseReason: '', studyPausedTopic: '', studySessions: []
  }));
  expect(state.currentStudySessionId).toBeNull();
  expect(state.studyPauseReason).toBe('inactivity');
  expect(state.studyPausedTopic).toBe(normalizedTopic);
  const saved = state.studySessions.find(session => session.id === sessionId);
  expect(saved).toBeTruthy();
  expect(saved.notes).toContain('Keep This Note');
});

test('Study Sessions auto-stop can be disabled without stopping an inactive recording', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true, studyAutoStopMinutes: 0 });

  const topic = 'BLB regression no auto-stop ' + Date.now();
  const started = await extensionWorker.evaluate(value => startStudyTopicFromPopup(value), topic);
  expect(started).toMatchObject({ ok: true, recording: true });

  const sessionId = await extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ currentStudySessionId: null })).currentStudySessionId
  );
  await extensionStorage.set({ studyLastActivityAt: Date.now() - 24 * 60 * 60 * 1000 });
  await extensionWorker.evaluate(() => checkStudyAutoStop());

  const state = await extensionWorker.evaluate(() => chrome.storage.local.get({
    currentStudySessionId: null, studyPauseReason: '', studyPausedTopic: ''
  }));
  expect(state.currentStudySessionId).toBe(sessionId);
  expect(state.studyPauseReason).toBe('');
  expect(state.studyPausedTopic).toBe('');
});

test('Alt+B refuses stale Show on BLB and Double-click preferences on sensitive government hosts', async ({ page, extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled: true,
    redirectEnabled: false,
    pageSelectionButtonSites: { 'gov.scot': true },
    doubleClickBlbSites: { 'gov.scot': true }
  });

  await page.route('https://www.gov.scot/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>Government test page</title></head><body><p id="sensitive-selection">John 3:16</p></body></html>'
  }));
  await page.goto('https://www.gov.scot/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const target = document.querySelector('#sensitive-selection');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const beforeIds = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
  await page.waitForTimeout(300);
  const newTabs = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
    tabs.filter(tab => !before.includes(tab.id)).map(tab => tab.url || tab.pendingUrl || '')
  ), beforeIds);

  expect(newTabs, 'Alt+B must not bypass the sensitive-site gate even with stale saved preferences').toEqual([]);
});

test('Study Sessions confirmed deletion stops and removes only the selected recording, while delete-all clears remaining history', async ({ context, extensionId, extensionStorage, extensionWorker }) => {
  await extensionStorage.clear();
  const inactiveTopic = 'BLB confirmed delete inactive ' + Date.now();
  const activeTopic = 'BLB confirmed delete active ' + Date.now();
  const titleCase = value => value.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  const inactiveTitle = titleCase(inactiveTopic);
  const activeTitle = titleCase(activeTopic);

  await extensionWorker.evaluate(async value => startStudyTopicFromPopup(value, 'Preserve this separate note'), inactiveTopic);
  await extensionWorker.evaluate(async value => startStudyTopicFromPopup(value, 'Delete with active topic'), activeTopic);

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await page.evaluate(() => {
    window.__studyConfirmMessages = [];
    window.confirm = message => {
      window.__studyConfirmMessages.push(String(message));
      return true;
    };
  });

  await page.locator('#studyTopic').fill(activeTitle);
  await expect(page.locator('#clearSelectedTopic')).toBeEnabled();
  await page.locator('#clearStudy').click();
  await page.locator('#clearSelectedTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Cleared:');

  let state = await extensionWorker.evaluate(() => getStudyUiState());
  expect(state).toMatchObject({ ok: true, recording: false, currentSession: null });
  expect(state.topics).toContain(inactiveTitle);
  expect(state.topics).not.toContain(activeTitle);
  expect(state.topicStats[inactiveTitle].notes).toBe(1);
  expect(state.topicStats[activeTitle]).toBeUndefined();

  await page.locator('#clearStudy').click();
  await page.locator('#clearAllTopics').click();
  await expect(page.locator('#studyStatus')).toContainText('All topics cleared.');
  state = await extensionWorker.evaluate(() => getStudyUiState());
  expect(state).toMatchObject({ ok: true, recording: false, currentSession: null, topics: [] });
  expect(await page.evaluate(() => window.__studyConfirmMessages)).toEqual([
    expect.stringContaining('is recording'),
    expect.stringContaining('Delete all Study data?')
  ]);
  await page.close();
});

test('Global master OFF blocks all four selection actions while preserving site preferences', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled: false,
    redirectEnabled: false,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true }
  });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  const tab = await extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  );
  expect(tab?.id).toEqual(expect.any(Number));

  // Exercise the exact background message boundary used by the floating
  // button and Double-click content-script actions. Execute in the tab's
  // isolated world so Chromium supplies the real sender.tab metadata.
  const messageResults = await extensionWorker.evaluate(async tabId => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async () => {
        const floating = await chrome.runtime.sendMessage({
          type: 'blbSuiteOpenSelectionText',
          requestId: 'master-off-floating-' + Date.now(),
          text: 'John 3:16'
        });
        const doubleClick = await chrome.runtime.sendMessage({
          type: 'blbSuiteOpenDoubleClickSelectionText',
          requestId: 'master-off-double-click-' + Date.now(),
          text: 'John 3:16'
        });
        return { floating, doubleClick };
      }
    });
    return results[0]?.result || null;
  }, tab.id);

  expect(messageResults?.floating?.ok).toBe(false);
  expect(messageResults?.doubleClick?.ok).toBe(false);

  // Right-click uses the registered context-menu handler; Alt+B uses the
  // registered command handler. Both must independently enforce the master
  // switch even when their per-site preferences remain enabled.
  const otherResults = await extensionWorker.evaluate(async activeTab => {
    await handleBlbSelectionContextMenuClick({
      menuItemId: 'blb-suite-web-selection',
      selectionText: 'John 3:16'
    }, activeTab);
    const altB = await handleOpenBibleSelectionCommand();
    return {
      altB,
      pageButtonEligible: await isPageButtonEnabledForHostname('example.com'),
      contextMenuEligible: await shouldShowBlbContextMenu(activeTab, 'John 3:16')
    };
  }, tab);

  expect(otherResults.altB).toMatchObject({ ok: false, reason: 'disabled' });
  expect(otherResults.pageButtonEligible).toBe(false);
  expect(otherResults.contextMenuEligible).toBe(false);

  const finalState = await extensionWorker.evaluate(async () => {
    const settings = await chrome.storage.local.get({
      masterEnabled: true,
      redirectEnabled: true,
      pageSelectionButtonSites: {},
      doubleClickBlbSites: {}
    });
    const tabs = await chrome.tabs.query({});
    const openedReferenceTabs = tabs.filter(item => {
      try {
        const url = new URL(String(item.url || item.pendingUrl || ''));
        return url.hostname === 'www.blueletterbible.org' &&
          url.pathname === '/kjv/jhn/3/16/';
      } catch (_) { return false; }
    });
    return { settings, openedReferenceTabCount: openedReferenceTabs.length };
  });

  expect(finalState.settings).toMatchObject({
    masterEnabled: false,
    redirectEnabled: false,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true }
  });
  expect(finalState.openedReferenceTabCount).toBe(0);
});



test('Study Sessions alarm creation failure rolls back a newly started recording', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled:true,
    studyAutoStopMinutes:10,
    currentStudySessionId:null,
    studyLastActivityAt:0,
    studyPausedTopic:'Previously Paused Topic',
    studyPauseReason:'inactivity'
  });

  const topic = 'BLB regression failed alarm start ' + Date.now();
  const attempt = await extensionWorker.evaluate(async value => {
    let calls = 0;
    const result = await startStudyTopicFromPopup(value, '', async () => {
      calls += 1;
      if (calls === 1) throw new Error('simulated alarm creation failure');
    });
    return {result, calls};
  }, topic);
  const result = attempt.result;

  expect(attempt.calls).toBe(2);
  expect(result).toMatchObject({
    ok:false,
    restored:true,
    alarmRestored:true,
    recording:false
  });
  expect(result.error).toContain('simulated alarm creation failure');

  const state = await extensionWorker.evaluate(() => chrome.storage.local.get({
    currentStudySessionId:null,
    studyLastActivityAt:0,
    studyPausedTopic:'',
    studyPauseReason:'',
    studySessions:[]
  }));
  expect(state.currentStudySessionId).toBeNull();
  expect(state.studyLastActivityAt).toBe(0);
  expect(state.studyPausedTopic).toBe('Previously Paused Topic');
  expect(state.studyPauseReason).toBe('inactivity');
  const normalizedTopic = await extensionWorker.evaluate(value => normalizeStudyTopic(value), topic);
  expect(state.studySessions.some(session => session.title === normalizedTopic)).toBe(true);
});



test('Study Sessions preserves the prior recording state when alarm rollback also fails', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled:true,
    studyAutoStopMinutes:10,
    currentStudySessionId:null,
    studyLastActivityAt:0,
    studyPausedTopic:'Paused Before Failure',
    studyPauseReason:'inactivity'
  });

  const topic = 'BLB regression persistent alarm failure ' + Date.now();
  const result = await extensionWorker.evaluate(value =>
    startStudyTopicFromPopup(value, '', async () => {
      throw new Error('persistent simulated alarm failure');
    }), topic
  );

  expect(result).toMatchObject({
    ok:false,
    restored:true,
    alarmRestored:false,
    recording:false
  });
  const state = await extensionWorker.evaluate(() => chrome.storage.local.get({
    currentStudySessionId:null,
    studyPausedTopic:'',
    studyPauseReason:''
  }));
  expect(state.currentStudySessionId).toBeNull();
  expect(state.studyPausedTopic).toBe('Paused Before Failure');
  expect(state.studyPauseReason).toBe('inactivity');
});

test('Study Sessions stop reports the completed stop when alarm cleanup fails', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({masterEnabled:true, studyAutoStopMinutes:0});
  const topic = 'BLB regression stop cleanup ' + Date.now();
  await extensionWorker.evaluate(value => startStudyTopicFromPopup(value), topic);

  const result = await extensionWorker.evaluate(() =>
    stopStudyRecording('manual', async () => {
      throw new Error('simulated alarm clear failure');
    })
  );
  expect(result).toMatchObject({ok:true, recording:false, alarmCleanupPending:true});
  const state = await extensionWorker.evaluate(() => chrome.storage.local.get({currentStudySessionId:'unexpected', studyLastActivityAt:-1}));
  expect(state.currentStudySessionId).toBeNull();
  expect(state.studyLastActivityAt).toBe(0);
});

test('Study topic deletion reports success when only alarm cleanup fails', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  const topic = 'BLB regression topic cleanup ' + Date.now();
  await extensionWorker.evaluate(value => saveStudyTopicFromPopup(value), topic);

  const result = await extensionWorker.evaluate(value =>
    clearStudyTopic(value, async () => {
      throw new Error('simulated alarm clear failure');
    }), topic
  );
  expect(result).toMatchObject({ok:true, alarmCleanupPending:true});
  const state = await extensionWorker.evaluate(() => getStudySessions());
  expect(state.sessions.some(session => session.title.toLowerCase() === normalizeStudyTopic(topic).toLowerCase())).toBe(false);
});

test('Study data deletion reports success when only alarm cleanup fails', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  const topic = 'BLB regression all cleanup ' + Date.now();
  await extensionWorker.evaluate(value => startStudyTopicFromPopup(value), topic);

  const result = await extensionWorker.evaluate(() =>
    clearStudySessions(async () => {
      throw new Error('simulated alarm clear failure');
    })
  );
  expect(result).toMatchObject({ok:true, alarmCleanupPending:true});
  const state = await extensionWorker.evaluate(() => chrome.storage.local.get({
    studySessions:[], currentStudySessionId:null, studyTopics:[]
  }));
  expect(state.studySessions).toEqual([]);
  expect(state.currentStudySessionId).toBeNull();
  expect(state.studyTopics).toEqual([]);
});


test('Study auto-stop alarm is cleared on its next tick while auto-stop is disabled', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  await extensionStorage.set({
    masterEnabled:true,
    studyAutoStopMinutes:0,
    currentStudySessionId:'preserved-disabled-auto-stop-session',
    studyLastActivityAt:Date.now() - 24 * 60 * 60 * 1000
  });
  await extensionWorker.evaluate(() => chrome.alarms.create(STUDY_AUTOSTOP_ALARM, {
    delayInMinutes:1,
    periodInMinutes:1
  }));
  expect(await extensionWorker.evaluate(() => chrome.alarms.get(STUDY_AUTOSTOP_ALARM))).toBeTruthy();

  await extensionWorker.evaluate(() => checkStudyAutoStop());

  expect(await extensionWorker.evaluate(() => chrome.alarms.get(STUDY_AUTOSTOP_ALARM))).toBeUndefined();
  const state = await extensionWorker.evaluate(() => chrome.storage.local.get({currentStudySessionId:null}));
  expect(state.currentStudySessionId).toBe('preserved-disabled-auto-stop-session');
});

test('Study Sessions auto-stop alarm follows recording, settings, and master-toggle lifecycle', async ({ extensionWorker, extensionStorage }) => {
  const alarmName = 'blb-study-auto-stop';
  const readAlarm = () => extensionWorker.evaluate(name => chrome.alarms.get(name), alarmName);
  const waitForAlarm = async expected => {
    await expect.poll(async () => Boolean(await readAlarm()), { timeout: 10000 }).toBe(expected);
  };

  await extensionStorage.clear();
  await extensionStorage.set({ masterEnabled: true, studyAutoStopMinutes: 10 });
  expect(await readAlarm()).toBeUndefined();

  const topic = 'BLB regression alarm lifecycle ' + Date.now();
  const started = await extensionWorker.evaluate(value => startStudyTopicFromPopup(value), topic);
  expect(started).toMatchObject({ ok: true, recording: true });
  await waitForAlarm(true);
  expect(await readAlarm()).toMatchObject({ periodInMinutes: 1 });

  // Changing the inactivity threshold keeps the periodic alarm active while
  // changing the value that checkStudyAutoStop reads on each alarm tick.
  await extensionStorage.set({ studyAutoStopMinutes: 20 });
  await expect.poll(() => extensionWorker.evaluate(() => getStudyAutoStopMinutes())).toBe(20);
  await waitForAlarm(true);

  // Disabling auto-stop clears the scheduled alarm without ending the session.
  await extensionStorage.set({ studyAutoStopMinutes: 0 });
  await waitForAlarm(false);
  let state = await extensionWorker.evaluate(() => chrome.storage.local.get({ currentStudySessionId: null }));
  expect(state.currentStudySessionId).toBeTruthy();

  // Re-enabling the setting recreates the alarm for the still-active session.
  await extensionStorage.set({ studyAutoStopMinutes: 10 });
  await waitForAlarm(true);

  // The global master gate clears the alarm; restoring it recreates the alarm
  // because the recording itself remains active.
  await extensionStorage.set({ masterEnabled: false });
  await waitForAlarm(false);
  await extensionStorage.set({ masterEnabled: true });
  await waitForAlarm(true);

  await extensionWorker.evaluate(() => stopStudyRecording('manual'));
  await waitForAlarm(false);
});

test('Global master OFF then ON restores both independently enabled site selection features', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled: true,
    redirectEnabled: false,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true }
  });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.evaluate(() => {
    const target = document.createElement('p');
    target.id = 'global-toggle-restored-double-click';
    target.innerHTML = 'Matthew <span id="global-toggle-restored-double-click-chapter">18</span>';
    target.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;padding:12px;font:24px Arial,sans-serif;';
    document.body.appendChild(target);
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const floatingButton = page.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible({ timeout: 10000 });
  await extensionStorage.set({ masterEnabled: false });
  await expect(floatingButton).toBeHidden({ timeout: 10000 });

  await expect.poll(() => extensionWorker.evaluate(async () => ({
    pageButton: await isPageButtonEnabledForHostname('example.com'),
    contextMenu: await shouldShowBlbContextMenu({
      url: 'https://example.com/', title: 'Example'
    }, 'John 3:16')
  }))).toEqual({ pageButton: false, contextMenu: false });

  // Re-enabling the global switch must reactivate both independently saved
  // site features, not just restore the floating button's eligibility.
  await extensionStorage.set({ masterEnabled: true });
  await expect(floatingButton).toBeVisible({ timeout: 15000 });
  await expect.poll(() => extensionWorker.evaluate(async () => ({
    pageButton: await isPageButtonEnabledForHostname('example.com'),
    contextMenu: await shouldShowBlbContextMenu({
      url: 'https://example.com/', title: 'Example'
    }, 'John 3:16')
  }))).toEqual({ pageButton: true, contextMenu: true });

  // Exercise the restored Double-click listener with a real browser gesture.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const beforeIds = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await page.locator('#global-toggle-restored-double-click-chapter').dblclick();
  await expect.poll(() => extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
    tabs.some(tab => !before.includes(tab.id) &&
      new URL(tab.url || tab.pendingUrl || 'about:blank').hostname === 'www.blueletterbible.org' &&
      new URL(tab.url || tab.pendingUrl || 'about:blank').pathname === '/kjv/mat/18/')
  ), beforeIds), { timeout: 15000 }).toBe(true);
});


test('sensitive-site policy blocks all four selection actions despite stale enabled site preferences', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled: true,
    redirectEnabled: false,
    pageSelectionButtonSites: { 'gov.scot': true },
    doubleClickBlbSites: { 'gov.scot': true }
  });
  await page.route('https://www.gov.scot/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>Government test page</title></head><body><p id="sensitive-all-actions">John 3:16</p></body></html>'
  }));
  await page.goto('https://www.gov.scot/', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // Floating Show on BLB and Double-click must not be activated on a sensitive
  // host, even when stale per-site preferences remain enabled.
  await expect(page.locator('#blb-suite-page-selection-button')).toHaveCount(0);
  const beforeIds = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await page.locator('#sensitive-all-actions').dblclick();

  // The native context-menu surface is unavailable in headless Chromium.
  // Exercise the exact registered onClicked handler and its eligibility gate.
  const tab = await extensionWorker.evaluate(() =>
    chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => active)
  );
  const gates = await extensionWorker.evaluate(async activeTab => {
    const rightClickEligible = await shouldShowBlbContextMenu(activeTab, 'John 3:16');
    await handleBlbSelectionContextMenuClick({
      menuItemId: 'blb-suite-web-selection',
      selectionText: 'John 3:16'
    }, activeTab);
    const altB = await handleOpenBibleSelectionCommand();
    return {
      floatingEligible: await isPageButtonEnabledForHostname('gov.scot'),
      rightClickEligible,
      altB
    };
  }, tab);

  expect(gates.floatingEligible).toBe(false);
  expect(gates.rightClickEligible).toBe(false);
  expect(gates.altB).toMatchObject({ ok: false, reason: 'site-disabled' });

  await expect.poll(() => extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
    tabs.filter(item => !before.includes(item.id) && (() => {
      try {
        const url = new URL(item.url || item.pendingUrl || 'about:blank');
        return url.hostname === 'www.blueletterbible.org' &&
          url.pathname === '/kjv/jhn/3/16/';
      } catch (_) { return false; }
    })()).length
  ), beforeIds), { timeout: 3000 }).toBe(0);
});


async function waitForNewBlbPath(extensionWorker, beforeIds, expectedPath) {
  let match = null;
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(() => chrome.tabs.query({}).then(items =>
      items.map(tab => ({ id:tab.id, url:tab.url || tab.pendingUrl || '' }))
    ));
    match = tabs.find(tab => {
      if (beforeIds.includes(tab.id)) return false;
      try {
        const url = new URL(tab.url);
        return url.hostname === 'www.blueletterbible.org' && url.pathname === expectedPath;
      } catch (_) { return false; }
    }) || null;
    return !!match;
  }, { timeout:15000 }).toBe(true);
  return match;
}

async function removeBlbTab(extensionWorker, tabId) {
  await extensionWorker.evaluate(id => chrome.tabs.remove(id).catch(() => {}), tabId);
}

async function selectLifecycleReference(page, id, text) {
  await page.evaluate(({ id, text }) => {
    let target = document.getElementById(id);
    if (!target) {
      target = document.createElement('p');
      target.id = id;
      document.body.appendChild(target);
    }
    target.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles:true }));
  }, { id, text });
}

test('Show on BLB OFF blocks Floating Button, Right Click, and Alt+B while Double-click remains enabled', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{ 'example.com':true },
    doubleClickBlbSites:{ 'example.com':true }
  });
  await page.route('https://example.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>Action gate fixture</title></head><body><main>Action gate fixture</main></body></html>'
  }));
  await page.goto('https://example.com/', { waitUntil:'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(500);

  // Begin with both features active, then turn only Show on BLB OFF on the
  // already-open page to exercise the live storage-change lifecycle.
  await selectLifecycleReference(page, 'show-off-reference', 'John 3:16');
  const floatingButton = page.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible({ timeout:10000 });
  await extensionStorage.set({ pageSelectionButtonSites:{ 'example.com':false } });
  await expect(floatingButton).toHaveCount(0, { timeout:10000 });
  const activeTab = await extensionWorker.evaluate(() =>
    chrome.tabs.query({ active:true, currentWindow:true }).then(([tab]) => tab)
  );
  expect(await extensionWorker.evaluate(tab =>
    shouldShowBlbContextMenu(tab, 'John 3:16'), activeTab
  )).toBe(false);

  const beforeBlockedActions = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await extensionWorker.evaluate(async tab => {
    await handleBlbSelectionContextMenuClick({
      menuItemId:'blb-suite-web-selection',
      selectionText:'John 3:16'
    }, tab);
  }, activeTab);
  const altB = await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
  expect(altB).toMatchObject({ ok:false, reason:'site-disabled' });

  const afterBlockedActions = await extensionWorker.evaluate(before => chrome.tabs.query({}).then(tabs =>
    tabs.filter(tab => !before.includes(tab.id) && (() => {
      try {
        const url = new URL(tab.url || tab.pendingUrl || '');
        return url.hostname === 'www.blueletterbible.org';
      } catch (_) { return false; }
    })()).length
  ), beforeBlockedActions);
  expect(afterBlockedActions).toBe(0);

  const beforeDoubleClick = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await page.locator('#show-off-reference').dblclick();
  const doubleClickTab = await waitForNewBlbPath(extensionWorker, beforeDoubleClick, '/kjv/jhn/3/16/');
  expect(new URL(doubleClickTab.url).pathname).toBe('/kjv/jhn/3/16/');
  await removeBlbTab(extensionWorker, doubleClickTab.id);
});

test('Double-click OFF blocks only Double-click while Floating Button, Right Click, and Alt+B remain enabled', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{ 'example.com':true },
    doubleClickBlbSites:{ 'example.com':true }
  });
  await page.route('https://example.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>Action gate fixture</title></head><body><main>Action gate fixture</main></body></html>'
  }));
  await page.goto('https://example.com/', { waitUntil:'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(500);

  // Confirm Double-click is initially active, then turn only that feature OFF
  // while the same external page remains open.
  await selectLifecycleReference(page, 'double-click-before-off-reference', 'John 3:16');
  let before = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await page.locator('#double-click-before-off-reference').dblclick();
  let opened = await waitForNewBlbPath(extensionWorker, before, '/kjv/jhn/3/16/');
  await removeBlbTab(extensionWorker, opened.id);
  await page.bringToFront();
  await extensionStorage.set({ doubleClickBlbSites:{ 'example.com':false } });
  await page.waitForTimeout(300);

  // Floating Button: the real control appears after a live selection and opens BLB.
  await selectLifecycleReference(page, 'show-on-floating-reference', 'John 3:17');
  const floatingButton = page.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible({ timeout:10000 });
  before = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await floatingButton.click();
  opened = await waitForNewBlbPath(extensionWorker, before, '/kjv/jhn/3/17/');
  await removeBlbTab(extensionWorker, opened.id);

  // Right Click: invoke the registered onClicked handler with the live selection.
  await page.bringToFront();
  await selectLifecycleReference(page, 'show-on-right-click-reference', 'John 3:18');
  const activeTab = await extensionWorker.evaluate(() =>
    chrome.tabs.query({ active:true, currentWindow:true }).then(([tab]) => tab)
  );
  expect(await extensionWorker.evaluate(tab =>
    shouldShowBlbContextMenu(tab, 'John 3:18'), activeTab
  )).toBe(true);
  before = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await extensionWorker.evaluate(async tab => {
    await handleBlbSelectionContextMenuClick({
      menuItemId:'blb-suite-web-selection',
      selectionText:'John 3:18'
    }, tab);
  }, activeTab);
  opened = await waitForNewBlbPath(extensionWorker, before, '/kjv/jhn/3/18/');
  await removeBlbTab(extensionWorker, opened.id);

  // Alt+B: call the same handler registered for the browser command.
  await page.bringToFront();
  await selectLifecycleReference(page, 'show-on-alt-b-reference', 'John 3:19');
  before = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  const altB = await extensionWorker.evaluate(() => handleOpenBibleSelectionCommand());
  expect(altB).toMatchObject({ ok:true });
  opened = await waitForNewBlbPath(extensionWorker, before, '/kjv/jhn/3/19/');
  await removeBlbTab(extensionWorker, opened.id);

  // Double-click: the disabled site preference must leave no destination tab.
  await page.bringToFront();
  await selectLifecycleReference(page, 'double-click-off-reference', 'John 3:20');
  before = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await page.locator('#double-click-off-reference').dblclick();
  await expect.poll(() => extensionWorker.evaluate(previous => chrome.tabs.query({}).then(tabs =>
    tabs.some(tab => !previous.includes(tab.id) && (() => {
      try {
        const url = new URL(tab.url || tab.pendingUrl || '');
        return url.hostname === 'www.blueletterbible.org';
      } catch (_) { return false; }
    })())
  ), before), { timeout:1500 }).toBe(false);
});


test('BLB main host exposes the floating Show on BLB action while Double-click stays excluded', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{ 'blueletterbible.org':true },
    // A stale saved value must not activate Double-click on BLB itself.
    doubleClickBlbSites:{ 'blueletterbible.org':true }
  });
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>BLB main-host fixture</title></head><body><main>BLB main-host fixture</main></body></html>'
  }));
  await page.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil:'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(500);

  await selectLifecycleReference(page, 'blb-main-host-selection', 'John 3:17');
  const floatingButton = page.locator('#blb-suite-page-selection-button');
  await expect(floatingButton).toBeVisible({ timeout:10000 });

  const activeTab = await extensionWorker.evaluate(() =>
    chrome.tabs.query({ active:true, currentWindow:true }).then(([tab]) => tab)
  );
  expect(await extensionWorker.evaluate(tab =>
    shouldShowBlbContextMenu(tab, 'John 3:17'), activeTab
  )).toBe(true);

  const before = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  await floatingButton.click();
  const opened = await waitForNewBlbPath(extensionWorker, before, '/kjv/jhn/3/17/');
  expect(new URL(opened.url).pathname).toBe('/kjv/jhn/3/17/');
  await removeBlbTab(extensionWorker, opened.id);
});
