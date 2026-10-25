const { test, expect } = require('./fixtures');

test('Study Sessions lifecycle creates a topic, edits notes, stops recording, and retains history', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  const topic = 'BLB regression lifecycle ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');

  const started = await extensionWorker.evaluate(async ({ topic }) =>
    chrome.runtime.sendMessage({
      type: 'blbSuiteStartStudyTopic',
      title: topic,
      note: 'Initial note'
    }), { topic });
  expect(started).toMatchObject({ ok: true, recording: true, topic: normalizedTopic });

  const added = await extensionWorker.evaluate(async ({ topic }) =>
    chrome.runtime.sendMessage({
      type: 'blbSuiteAddStudyNoteToTopic',
      topic,
      note: 'Second note'
    }), { topic });
  expect(added).toMatchObject({ ok: true, topic: normalizedTopic });

  const updated = await extensionWorker.evaluate(async ({ topic }) =>
    chrome.runtime.sendMessage({
      type: 'blbSuiteUpdateStudyNoteToTopic',
      topic,
      originalNote: 'Initial note',
      note: 'Edited initial note'
    }), { topic });
  expect(updated).toMatchObject({ ok: true, topic: normalizedTopic });

  const active = await extensionWorker.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'blbSuiteGetStudyUiState' }));
  expect(active).toMatchObject({
    ok: true,
    recording: true,
    currentTopic: normalizedTopic,
    currentSession: { topic: normalizedTopic, notes: 2 }
  });
  expect(active.topicStats[normalizedTopic].notes).toBe(2);

  const stopped = await extensionWorker.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'blbSuiteStopStudyRecording' }));
  expect(stopped).toMatchObject({ ok: true, recording: false });

  const persisted = await extensionWorker.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'blbSuiteGetStudyUiState' }));
  expect(persisted.ok).toBe(true);
  expect(persisted.recording).toBe(false);
  expect(persisted.topics).toContain(normalizedTopic);
  expect(persisted.topicStats[normalizedTopic].notes).toBe(2);
});

test('Study Sessions reject empty topic and note input without corrupting the current session', async ({ extensionWorker, extensionStorage }) => {
  await extensionStorage.clear();
  const emptyStart = await extensionWorker.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'blbSuiteStartStudyTopic', title: '   ', note: 'ignored' }));
  expect(emptyStart).toMatchObject({ ok: false, reason: 'empty' });

  const topic = 'BLB regression empty-input ' + Date.now();
  const normalizedTopic = topic.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  const started = await extensionWorker.evaluate(async ({ topic }) =>
    chrome.runtime.sendMessage({ type: 'blbSuiteStartStudyTopic', title: topic }), { topic });
  expect(started).toMatchObject({ ok: true, recording: true, topic: normalizedTopic });

  const emptyNote = await extensionWorker.evaluate(async ({ topic }) =>
    chrome.runtime.sendMessage({ type: 'blbSuiteAddStudyNoteToTopic', topic, note: '   ' }), { topic });
  expect(emptyNote).toMatchObject({ ok: false, reason: 'empty' });

  const state = await extensionWorker.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'blbSuiteGetStudyUiState' }));
  expect(state).toMatchObject({ ok: true, recording: true, currentTopic: normalizedTopic });
  expect(state.currentSession.notes).toBe(0);
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
