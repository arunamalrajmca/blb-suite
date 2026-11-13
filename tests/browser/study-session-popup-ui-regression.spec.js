const { test, expect } = require('./fixtures');

async function waitForStudyPopupReady(page) {
  await page.waitForFunction(
    () => !document.body.classList.contains('popup-loading') &&
      !document.body.classList.contains('sensitive-restricted'),
    null,
    { timeout: 10000 }
  );
  await expect(page.locator('#studyTopic')).toBeVisible();
  await expect(page.locator('#studyTopic')).toBeEnabled();
}

async function allDownloads(extensionWorker) {
  return extensionWorker.evaluate(() => new Promise(resolve => {
    chrome.downloads.search({}, items => resolve(items || []));
  }));
}

test('Study Sessions auto-stop setting persists when changed in the popup', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const topic = 'Popup auto-stop setting ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
  await extensionWorker.evaluate(async value => {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await chrome.storage.local.set({
      masterEnabled: true,
      studyTopics: [value],
      studySelectedTopic: value,
      currentStudySessionId: 'popup-auto-stop-regression',
      studySessions: [{
        id: 'popup-auto-stop-regression',
        title: value,
        date,
        dateLabel: date,
        refs: [],
        strongs: [],
        searchTerms: [],
        notes: []
      }]
    });
  }, normalizedTopic);
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);
  await expect(page.locator('#studyTopic')).toHaveValue(normalizedTopic);

  const autoStop = page.locator('#studyAutoStop');
  await expect(autoStop).toBeVisible();
  await autoStop.selectOption('0');
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ studyAutoStopMinutes: 15 })).studyAutoStopMinutes
  )).toBe(0);

  await autoStop.selectOption('10');
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({ studyAutoStopMinutes: 15 })).studyAutoStopMinutes
  )).toBe(10);
  await page.locator('#stopTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Last Recording Stopped');
  await page.close();
});

test('Study Sessions popup starts recording, saves a note, and stops without losing history', async ({
  context,
  extensionId,
  extensionStorage,
  extensionWorker
}) => {
  await extensionStorage.clear();

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);

  const topic = 'Popup UI regression ' + Date.now();
  const note = 'Note saved through the visible popup controls';
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');

  await page.locator('#studyTopic').fill(topic);
  await expect(page.locator('#startTopic')).toBeEnabled();
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');

  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['currentStudySessionId', 'studySelectedTopic']);
    return { recording: Boolean(state.currentStudySessionId), topic: state.studySelectedTopic };
  })).toEqual({ recording: true, topic: normalizedTopic });

  await page.locator('#studyNote').fill(note);
  await page.locator('#studyNote').press('Control+Enter');
  await expect(page.locator('#studyStatus')).toContainText('Note saved to');

  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['currentStudySessionId', 'studySessions']);
    const session = state.studySessions.find(item => item.id === state.currentStudySessionId);
    return session?.notes || [];
  })).toContain('Note Saved Through the Visible Popup Controls');

  await page.locator('#stopTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Last Recording Stopped');

  const finalState = await extensionWorker.evaluate(() => chrome.storage.local.get([
    'currentStudySessionId', 'studySessions', 'studySelectedTopic'
  ]));
  expect(finalState.currentStudySessionId).toBeNull();
  expect(finalState.studySelectedTopic).toBe('');
  expect(finalState.studySessions.some(session =>
    session.title === normalizedTopic &&
    session.notes.includes('Note Saved Through the Visible Popup Controls')
  )).toBe(true);

  await page.close();
});

test('Study Sessions popup pauses and restarts the selected recording without creating duplicate history', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);
  const topic = 'Popup pause resume ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');

  await page.locator('#studyTopic').fill(topic);
  await expect(page.locator('#startTopic')).toBeEnabled();
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');

  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording paused');
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['currentStudySessionId', 'studySelectedTopic', 'studySessions']);
    return {
      currentStudySessionId: state.currentStudySessionId ?? null,
      selectedTopic: state.studySelectedTopic,
      sessions: state.studySessions.length
    };
  })).toMatchObject({ currentStudySessionId: null, selectedTopic: normalizedTopic, sessions: 1 });

  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');
  const resumed = await extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['currentStudySessionId', 'studySessions']);
    return { active: Boolean(state.currentStudySessionId), count: state.studySessions.length };
  });
  expect(resumed).toEqual({ active: true, count: 1 });

  await page.locator('#stopTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Last Recording Stopped');
  await page.close();
});

test('Study Sessions popup rejects an empty topic without starting a recording', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);

  await expect(page.locator('#startTopic')).toBeDisabled();
  await expect(page.locator('#studyStatus')).not.toContainText('Recording started');
  const state = await extensionWorker.evaluate(() => chrome.storage.local.get([
    'currentStudySessionId', 'studySessions'
  ]));
  expect(state.currentStudySessionId ?? null).toBeNull();
  expect(state.studySessions ?? []).toHaveLength(0);
  await page.close();
});



test('Study Sessions History menu opens the saved Strong\'s entries and Criteria Search terms', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const topic = 'Popup history actions ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
  await extensionWorker.evaluate(async value => {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await chrome.storage.local.set({
      masterEnabled: true,
      studyTopics: [value],
      studySelectedTopic: value,
      studySessions: [{
        id: 'popup-history-regression',
        title: value,
        date,
        dateLabel: date,
        refs: [
          {book:'John', bookNumber:43, chapter:3, from:16, to:16, version:'kjv', text:'3:16'},
          {book:'Romans', bookNumber:45, chapter:8, from:28, to:28, version:'kjv', text:'8:28'}
        ],
        strongs: ['H430'],
        searchTerms: ['Grace', 'Mercy'],
        notes: []
      }]
    });
  }, normalizedTopic);

  let submittedMultiVerseText = '';
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Study history fixture</title></head><body>Study history fixture</body></html>'
  }));
  await context.route('https://www.blueletterbible.org/tools/MultiVerse.cfm', route => {
    submittedMultiVerseText = new URLSearchParams(route.request().postData() || '').get('mvText') || '';
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><title>MultiVerse fixture</title></head><body>MultiVerse fixture</body></html>'
    });
  });
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);
  await expect.poll(() => page.locator('#studyTopic').inputValue()).toBe(normalizedTopic);

  await page.locator('#multiView').click();
  await expect(page.locator('#historyMenu')).toBeVisible();
  await expect(page.locator('#historyStrongs')).toBeEnabled();
  await page.locator('#historyStrongs').click();
  await expect(page.locator('#studyStatus')).toContainText("Opened 1 KJV Strong's entry");
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.tabs.query({})).some(tab =>
      [tab.url, tab.pendingUrl].some(url => /\/lexicon\/h430\/kjv\/wlc\/0-1\//i.test(url || ''))
    )
  )).toBe(true);

  await page.locator('#multiView').click();
  await expect(page.locator('#historySearchTerms')).toBeEnabled();
  await page.locator('#historySearchTerms').click();
  await expect(page.locator('#studyStatus')).toContainText('Opened 1 Criteria Search tab');
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.some(tab => {
      if (!String(tab.url || '').includes('/search/search.cfm?')) return false;
      const criteria = new URL(tab.url).searchParams.get('Criteria') || '';
      return criteria === '"Grace" OR "Mercy"';
    });
  })).toBe(true);

  await page.locator('#multiView').click();
  await expect(page.locator('#historyVerseRefs')).toBeEnabled();
  await page.locator('#historyVerseRefs').click();
  await expect(page.locator('#studyStatus')).toContainText('Opening 2 references in MultiVerse');
  await expect.poll(() => submittedMultiVerseText).toBe('john 3:16; romans 8:28');
  await page.close();
});

test('Study Sessions keeps the selected recording topic when clearing it cannot stop', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const topic = 'Popup stop failure preserves topic ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
  await extensionWorker.evaluate(async value => {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await chrome.storage.local.set({
      masterEnabled: true,
      studyTopics: [value],
      studySelectedTopic: value,
      currentStudySessionId: 'popup-clear-stop-failure-regression',
      studySessions: [{
        id: 'popup-clear-stop-failure-regression',
        title: value,
        date,
        dateLabel: date,
        refs: [],
        strongs: [],
        searchTerms: [],
        notes: []
      }]
    });
  }, normalizedTopic);

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);
  await expect(page.locator('#studyTopic')).toHaveValue(normalizedTopic);
  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type === 'blbSuiteStopStudyRecording') {
        return Promise.resolve({ok:false, reason:'storage-write-failed'});
      }
      return originalSendMessage(message, ...args);
    };
  });

  await page.locator('#clearSelectedTopicInput').click();
  await expect(page.locator('#studyStatus')).toContainText('Unable to stop recording.');
  await expect(page.locator('#studyTopic')).toHaveValue(normalizedTopic);
  const state = await extensionWorker.evaluate(() => chrome.storage.local.get([
    'studySelectedTopic', 'currentStudySessionId'
  ]));
  expect(state.studySelectedTopic).toBe(normalizedTopic);
  expect(state.currentStudySessionId).toBe('popup-clear-stop-failure-regression');
  await page.close();
});

test("Study Sessions History reports partial Strong's destination failures", async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const topic = 'Popup partial Strong history ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
  await extensionWorker.evaluate(async value => {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await chrome.storage.local.set({
      masterEnabled: true,
      studyTopics: [value],
      studySelectedTopic: value,
      studySessions: [{
        id: 'popup-partial-strong-history-regression',
        title: value,
        date,
        dateLabel: date,
        refs: [],
        strongs: ['H430', 'H3068'],
        searchTerms: [],
        notes: []
      }]
    });
  }, normalizedTopic);

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);
  await expect.poll(() => page.locator('#studyTopic').inputValue()).toBe(normalizedTopic);
  await page.evaluate(async () => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    const [activeTab] = await chrome.tabs.query({active:true, currentWindow:true});
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type === 'blbSuiteOpenStrongHistory') {
        if (message.value === 'H430') return Promise.resolve({ok:false, reason:'tab-create-failed'});
        return Promise.resolve({ok:true, tabId:activeTab.id});
      }
      return originalSendMessage(message, ...args);
    };
  });

  await page.locator('#multiView').click();
  await page.locator('#historyStrongs').click();
  await expect(page.locator('#studyStatus')).toContainText("Opened 1 of 2 KJV Strong's entries");
  await expect(page.locator('#studyStatus')).toContainText('Please retry the missing entries.');
  await page.close();
});

test('Study Sessions popup exposes whole-study and date-filtered PDF downloads', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const topic = 'Popup PDF actions ' + Date.now();
  await extensionWorker.evaluate(async value => {
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await chrome.storage.local.set({
      masterEnabled: true,
      studyTopics: [value],
      studySelectedTopic: value,
      studySessions: [{
        id: 'popup-pdf-regression',
        title: value,
        date,
        dateLabel: date,
        refs: [{book:'John', bookNumber:43, chapter:3, from:16, to:16, version:'kjv', text:'3:16'}],
        strongs: [],
        searchTerms: ['Grace'],
        notes: ['PDF action regression note']
      }]
    });
  }, topic);

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);

  await page.locator('#downloadMenuButton').click();
  await expect(page.locator('#downloadWhole')).toBeEnabled();
  await page.locator('#downloadWhole').click();
  await expect(page.locator('#studyStatus')).toContainText('Whole study PDF downloaded.');

  await page.locator('#downloadMenuButton').click();
  await expect(page.locator('#downloadDate')).toBeEnabled();
  await page.locator('#downloadDate').click();
  await expect(page.locator('#dateQuickMenu')).toBeVisible();
  await page.locator('#dateToday').click();
  await expect(page.locator('#studyStatus')).toContainText('Date PDF downloaded:');

  await expect.poll(async () => extensionWorker.evaluate(() => new Promise(resolve => {
    chrome.downloads.search({}, items => resolve((items || []).filter(item =>
      item.state === 'complete' && /^data:application\/pdf;base64,/.test(item.url || '')
    ).length));
  }))).toBeGreaterThanOrEqual(2);
  await page.close();
});




test('Study Sessions auto-stop validates intervals and independently controls its alarm lifecycle', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({
      masterEnabled: true,
      studyAutoStopMinutes: 15,
      currentStudySessionId: 'auto-stop-lifecycle-regression',
      studyLastActivityAt: Date.now(),
      studySessions: [{
        id: 'auto-stop-lifecycle-regression',
        title: 'Auto Stop Lifecycle',
        date: '2026-11-12',
        dateLabel: '2026-11-12',
        refs: [],
        strongs: [],
        searchTerms: [],
        notes: []
      }]
    });
  });

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);

  const send = minutes => page.evaluate(value => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'blbSuiteSetStudyAutoStopMinutes', minutes: value }, resolve);
  }), minutes);
  const readAlarm = () => extensionWorker.evaluate(() => new Promise(resolve => {
    chrome.alarms.get('blb-study-auto-stop', resolve);
  }));

  const invalid = await send(7);
  expect(invalid).toMatchObject({ ok: false, error: 'Invalid auto-stop interval' });
  expect((await extensionWorker.evaluate(() => chrome.storage.local.get('studyAutoStopMinutes'))).studyAutoStopMinutes).toBe(15);

  await expect.poll(readAlarm).toMatchObject({ name: 'blb-study-auto-stop', periodInMinutes: 1 });
  expect(await send(0)).toMatchObject({ ok: true, minutes: 0 });
  await expect.poll(readAlarm).toBeUndefined();

  expect(await send(10)).toMatchObject({ ok: true, minutes: 10 });
  await expect.poll(readAlarm).toMatchObject({ name: 'blb-study-auto-stop', periodInMinutes: 1 });

  await extensionWorker.evaluate(() => chrome.storage.local.set({ masterEnabled: false }));
  await expect.poll(readAlarm).toBeUndefined();

  await extensionWorker.evaluate(() => chrome.storage.local.set({ masterEnabled: true }));
  await expect.poll(readAlarm).toMatchObject({ name: 'blb-study-auto-stop', periodInMinutes: 1 });

  await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({ currentStudySessionId: null });
    await chrome.alarms.clear('blb-study-auto-stop');
  });
  await page.close();
});

// Keep export regressions in the established Study Sessions spec so the existing
// Study Sessions CI selector discovers and executes them with the rest of the suite.

// Export success and rejection paths share this established Study Sessions spec.
// Keep the focused browser run tied to the current spec inventory.
test('Study export: selected Study Topic exports a PDF containing its saved reference and note', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');

  const topic = 'Export Regression ' + Date.now();
  const note = 'Study Export Integration Note';
  await page.locator('#studyTopic').fill(topic);
  await expect(page.locator('#startTopic')).toBeEnabled();
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');

  await page.locator('#studyNote').fill(note);
  await page.locator('#studyNote').press('Control+Enter');
  await expect(page.locator('#studyStatus')).toContainText('Note saved to');

  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Study export fixture</title></head><body><main>Study export fixture</main></body></html>'
  }));
  const blbPage = await context.newPage();
  await blbPage.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['studySessions', 'currentStudySessionId']);
    const session = state.studySessions.find(item => item.id === state.currentStudySessionId);
    return session?.refs || [];
  })).toContainEqual(expect.objectContaining({
    book: 'john', chapter: 3, from: 16, to: 16, version: 'kjv'
  }));

  await blbPage.goto('https://www.blueletterbible.org/search/search.cfm?Criteria=grace', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['studySessions', 'currentStudySessionId']);
    const session = state.studySessions.find(item => item.id === state.currentStudySessionId);
    return session?.searchTerms || [];
  })).toContain('Grace');
  await blbPage.close();

  await page.locator('#downloadMenuButton').click();
  await page.locator('#downloadTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('PDF downloaded: ' + topic);

  await expect.poll(async () => {
    const downloads = await allDownloads(extensionWorker);
    return downloads.filter(item => item.state === 'complete' && /^data:application\/pdf;base64,/.test(item.url || '')).length;
  }).toBeGreaterThan(0);

  const downloads = await allDownloads(extensionWorker);
  const item = downloads.find(entry => entry.state === 'complete' && /^data:application\/pdf;base64,/.test(entry.url || ''));
  expect(item).toBeDefined();
  const pdf = Buffer.from(item.url.split(',')[1], 'base64').toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain(topic);
  expect(pdf).toContain('John');
  expect(pdf).toContain(note);
  expect(pdf).toContain('Grace');

  await page.close();
});

test('Study export: rejects empty data, malformed dates, and topics without content without downloading', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');

  const emptyWhole = await page.evaluate(() => chrome.runtime.sendMessage({
    type: 'blbSuiteDownloadStudyWhole'
  }));
  expect(emptyWhole).toEqual({ok:false});

  const invalidDate = await page.evaluate(() => chrome.runtime.sendMessage({
    type: 'blbSuiteDownloadStudyDate',
    date: '2026/02/31'
  }));
  expect(invalidDate).toEqual({ok:false});

  const emptyTopic = 'Empty export topic ' + Date.now();
  const normalizedEmptyTopic = emptyTopic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');
  const saved = await page.evaluate(topic => chrome.runtime.sendMessage({
    type: 'blbSuiteSaveStudyTopic',
    title: topic
  }), emptyTopic);
  expect(saved).toMatchObject({ok:true, topic:normalizedEmptyTopic});

  const topicExport = await page.evaluate(topic => chrome.runtime.sendMessage({
    type: 'blbSuiteDownloadStudyTopic',
    topic
  }), saved.topic);
  expect(topicExport).toEqual({ok:false});
  expect(await allDownloads(extensionWorker)).toEqual([]);
  await page.close();
});


test('Study Sessions auto-stop reports a rejected save and restores the persisted value', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({
      masterEnabled:true,
      studyAutoStopMinutes:15,
      studyTopics:['Auto Stop Failure'],
      studySelectedTopic:'Auto Stop Failure',
      currentStudySessionId:'auto-stop-save-failure',
      studySessions:[{
        id:'auto-stop-save-failure',
        title:'Auto Stop Failure',
        date:'2026-11-13',
        dateLabel:'2026-11-13',
        refs:[],strongs:[],searchTerms:[],notes:[]
      }]
    });
  });
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);
  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value:message => message?.type === 'blbSuiteSetStudyAutoStopMinutes'
        ? Promise.resolve({ok:false,error:'simulated-save-failure'})
        : originalSendMessage(message)
    });
  });

  const autoStop = page.locator('#studyAutoStop');
  await expect(autoStop).toHaveValue('15');
  await autoStop.selectOption('10');
  await expect(autoStop).toHaveValue('15');
  await expect(page.locator('#studyStatus')).toContainText(
    'Unable to save the inactivity stop setting. The previous value was restored.'
  );
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({studyAutoStopMinutes:15})).studyAutoStopMinutes
  )).toBe(15);
  await page.close();
});

test('Study Sessions topic blur reports when the topic could not be saved', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);
  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value:message => message?.type === 'blbSuiteSaveStudyTopic'
        ? Promise.resolve({ok:false,error:'simulated-topic-save-failure'})
        : originalSendMessage(message)
    });
  });

  await page.locator('#studyTopic').fill('Unsaved Topic Failure');
  await page.locator('#studyTopic').press('Tab');
  await expect(page.locator('#studyStatus')).toContainText(
    'Unable to save this Study topic. Please try again.'
  );
  const stored = await extensionWorker.evaluate(() => chrome.storage.local.get({
    studyTopics:[],
    studySelectedTopic:''
  }));
  expect(stored.studyTopics).not.toContain('Unsaved Topic Failure');
  expect(stored.studySelectedTopic).not.toBe('Unsaved Topic Failure');
  await page.close();
});

test('Study Sessions restores the saved auto-stop value when alarm refresh fails', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionWorker.evaluate(async () => {
    await chrome.storage.local.set({
      masterEnabled:true,
      studyAutoStopMinutes:15,
      studySelectedTopic:'Auto Stop Alarm Rollback',
      currentStudySessionId:'auto-stop-alarm-refresh-rollback',
      studyLastActivityAt:Date.now(),
      studySessions:[{
        id:'auto-stop-alarm-refresh-rollback',
        title:'Auto Stop Alarm Rollback',
        date:'2026-11-13',
        dateLabel:'13 November 2026',
        refs:[],strongs:[],searchTerms:[],notes:[]
      }]
    });
    await refreshStudyAutoStopAlarm();
  });

  const rollback = await extensionWorker.evaluate(async () => {
    let failNextCreate = true;
    const realAlarms = chrome.alarms;
    const alarms = {
      clear:realAlarms.clear.bind(realAlarms),
      create:(...args) => {
        if (failNextCreate) {
          failNextCreate = false;
          return Promise.reject(new Error('simulated-alarm-create-failure'));
        }
        return realAlarms.create(...args);
      }
    };
    const result = await updateStudyAutoStopMinutes(10, () => refreshStudyAutoStopAlarm(alarms));
    return {
      result,
      settings:await chrome.storage.local.get({studyAutoStopMinutes:15}),
      alarm:await chrome.alarms.get('blb-study-auto-stop')
    };
  });
  expect(rollback.result).toMatchObject({ok:false, minutes:15, restored:true});
  expect(rollback.settings.studyAutoStopMinutes).toBe(15);
  expect(rollback.alarm).toMatchObject({name:'blb-study-auto-stop', periodInMinutes:1});

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);
  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value:message => message?.type === 'blbSuiteSetStudyAutoStopMinutes'
        ? Promise.resolve({ok:false, error:'simulated-alarm-refresh-failure', minutes:15, restored:true})
        : originalSendMessage(message)
    });
  });
  const autoStop = page.locator('#studyAutoStop');
  await expect(autoStop).toHaveValue('15');
  await autoStop.selectOption('0');
  await expect(autoStop).toHaveValue('15');
  await expect(page.locator('#studyStatus')).toContainText(
    'Unable to save the inactivity stop setting. The previous value was restored.'
  );
  await page.close();
});
