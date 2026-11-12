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

  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Study history fixture</title></head><body>Study history fixture</body></html>'
  }));
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
    (await chrome.tabs.query({})).some(tab => /\/lexicon\/h430\/kjv\/wlc\/0-1\//i.test(tab.url || ''))
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
      return criteria.toLowerCase() === 'grace or mercy';
    });
  })).toBe(true);

  await page.locator('#multiView').click();
  await expect(page.locator('#historyVerseRefs')).toBeEnabled();
  await page.locator('#historyVerseRefs').click();
  await expect(page.locator('#studyStatus')).toContainText('Opening 2 references in MultiVerse');
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.some(tab => {
      if (!String(tab.url || '').includes('/multiverse-post.html?')) return false;
      const mvText = new URL(tab.url).searchParams.get('mvText') || '';
      return mvText.includes('John 3:16') && mvText.includes('Romans 8:28');
    });
  })).toBe(true);
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

test('Study Sessions auto-stop setting persists when changed in the popup', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  await extensionWorker.evaluate(() => chrome.storage.local.set({ masterEnabled: true }));
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  await waitForStudyPopupReady(page);

  await page.locator('#studyTopic').fill('Popup auto-stop setting ' + Date.now());
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');

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
