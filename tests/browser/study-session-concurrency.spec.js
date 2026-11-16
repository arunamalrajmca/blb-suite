const { test, expect } = require('./fixtures');

test('concurrent Study captures preserve every reference, Strong\'s entry, and search term', async ({
  extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const topic = 'Concurrent Study captures ' + Date.now();
  const result = await extensionWorker.evaluate(async value => {
    const started = await startStudyTopicFromPopup(value);
    if (!started.ok) throw new Error('Could not start Study topic: ' + JSON.stringify(started));

    const outcomes = await Promise.all([
      recordStudyStrong('H430'),
      recordStudyStrong('G26'),
      recordStudySearchTerm('Grace'),
      recordStudySearchTerm('Mercy'),
      recordStudyRefs([{urlKey:'jhn', chapter:3, from:16, to:16, version:'kjv'}]),
      recordStudyRefs([{urlKey:'rom', chapter:8, from:28, to:28, version:'kjv'}])
    ]);
    const state = await chrome.storage.local.get(['studySessions','currentStudySessionId']);
    const session = state.studySessions.find(item => item.id === state.currentStudySessionId);
    return {outcomes, session};
  }, topic);

  expect(result.outcomes).toEqual([true, true, true, true, 1, 1]);
  expect(result.session.strongs).toEqual(['G26', 'H430']);
  expect(result.session.searchTerms).toEqual(['Grace', 'Mercy']);
  expect(result.session.refs.map(ref => ref.text).sort()).toEqual(['John 3:16', 'Romans 8:28']);
});

test('concurrent Study notes and capture operations do not overwrite one another', async ({
  extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const topic = 'Concurrent Study notes ' + Date.now();
  const result = await extensionWorker.evaluate(async value => {
    const started = await startStudyTopicFromPopup(value);
    if (!started.ok) throw new Error('Could not start Study topic: ' + JSON.stringify(started));

    const outcomes = await Promise.all([
      addStudyNoteToTopic(value, 'First concurrent note'),
      recordStudyStrong('H3068'),
      addStudyNoteToTopic(value, 'Second concurrent note'),
      recordStudySearchTerm('Faith')
    ]);
    const state = await chrome.storage.local.get(['studySessions','currentStudySessionId']);
    const session = state.studySessions.find(item => item.id === state.currentStudySessionId);
    return {outcomes, session};
  }, topic);

  expect(result.outcomes.map(item => item === true || item?.ok === true)).toEqual([true, true, true, true]);
  expect(result.session.notes).toEqual(['First Concurrent Note', 'Second Concurrent Note']);
  expect(result.session.strongs).toEqual(['H3068']);
  expect(result.session.searchTerms).toEqual(['Faith']);
});

test('clearing a Study topic cannot be undone by an overlapping capture', async ({
  extensionStorage, extensionWorker
}) => {
  await extensionStorage.clear();
  const topic = 'Concurrent Study clear ' + Date.now();
  const result = await extensionWorker.evaluate(async value => {
    const started = await startStudyTopicFromPopup(value);
    if (!started.ok) throw new Error('Could not start Study topic: ' + JSON.stringify(started));

    const outcomes = await Promise.all([
      clearStudyTopic(value),
      recordStudyStrong('H3068')
    ]);
    const state = await chrome.storage.local.get(['studySessions','studyTopics','currentStudySessionId']);
    return {outcomes, state};
  }, topic);

  expect(result.outcomes[0]).toMatchObject({ok:true});
  expect(result.outcomes[1]).toBe(false);
  expect(result.state.studySessions).toEqual([]);
  expect(result.state.studyTopics).toEqual([]);
  expect(result.state.currentStudySessionId).toBeNull();
});
