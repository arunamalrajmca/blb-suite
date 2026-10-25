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
  await page.close();
});

test('Study Sessions reject empty topic and note input without corrupting the current session', async ({ context, extensionId, extensionStorage }) => {
  await extensionStorage.clear();
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html');
  const send = message => page.evaluate(value => chrome.runtime.sendMessage(value), message);
  const emptyStart = await send({ type: 'blbSuiteStartStudyTopic', title: '   ', note: 'ignored' });
  expect(emptyStart).toMatchObject({ ok: false, reason: 'empty' });

  const topic = 'BLB regression empty-input ' + Date.now();
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
