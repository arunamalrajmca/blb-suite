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
  })).toContain('Note Saved Through The Visible Popup Controls');

  await page.locator('#stopTopic').click();
  await expect(page.locator('#studyStatus')).toContainText('Last Recording Stopped');

  const finalState = await extensionWorker.evaluate(() => chrome.storage.local.get([
    'currentStudySessionId', 'studySessions', 'studySelectedTopic'
  ]));
  expect(finalState.currentStudySessionId).toBeNull();
  expect(finalState.studySelectedTopic).toBe('');
  expect(finalState.studySessions.some(session =>
    session.topic === normalizedTopic &&
    session.notes.includes('Note Saved Through The Visible Popup Controls')
  )).toBe(true);

  await page.close();
});
