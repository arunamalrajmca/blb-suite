const { test, expect } = require('./fixtures');

test('Study Sessions popup starts recording, saves a note, and stops without losing history', async ({
  context,
  extensionId,
  extensionStorage,
  extensionWorker
}) => {
  await extensionStorage.clear();

  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');

  const topic = 'Popup UI regression ' + Date.now();
  const note = 'Note saved through the visible popup controls';
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');

  await page.locator('#studyTopic').fill(topic);
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

test('Study Sessions popup pauses and resumes the selected recording without creating duplicate history', async ({
  context, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  const topic = 'Popup pause resume ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ');

  await page.locator('#studyTopic').fill(topic);
  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording started');

  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Recording paused');
  await expect.poll(async () => extensionWorker.evaluate(async () => {
    const state = await chrome.storage.local.get(['currentStudySessionId', 'studyPausedTopic', 'studySessions']);
    return {
      currentStudySessionId: state.currentStudySessionId ?? null,
      pausedTopic: state.studyPausedTopic,
      sessions: state.studySessions.length
    };
  })).toMatchObject({ currentStudySessionId: null, pausedTopic: normalizedTopic, sessions: 1 });

  await expect(page.locator('#resumeStudy')).toBeVisible();
  await page.locator('#resumeStudy').click();
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

  await page.locator('#startTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Enter a topic first.');
  const state = await extensionWorker.evaluate(() => chrome.storage.local.get([
    'currentStudySessionId', 'studySessions'
  ]));
  expect(state.currentStudySessionId ?? null).toBeNull();
  expect(state.studySessions ?? []).toHaveLength(0);
  await page.close();
});

