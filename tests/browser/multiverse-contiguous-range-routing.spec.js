const { test, expect } = require('./fixtures');

test('MultiVerse redirects adjacent same-chapter ranges to the normal chapter range view', async ({
  extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({ masterEnabled: true });

  const result = await extensionWorker.evaluate(async () => openBlbMultiVerseRefs([
    { book: 'John', bookNumber: 43, chapter: 3, from: 16, to: 17, version: 'kjv' },
    { book: 'John', bookNumber: 43, chapter: 3, from: 18, to: 20, version: 'kjv' }
  ], true));

  expect(result.ok).toBe(true);
  expect(result.chapterRange).toBe(true);
  expect(result.count).toBe(5);
  expect(result.batchCount).toBe(1);
  expect(result.url).toBe('https://www.blueletterbible.org/kjv/jhn/3/16-20/');
  expect(result.tabIds).toHaveLength(1);
});

test('MultiVerse redirects overlapping same-chapter ranges after deduplication', async ({
  extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({ masterEnabled: true });

  const result = await extensionWorker.evaluate(async () => openBlbMultiVerseRefs([
    { book: 'John', bookNumber: 43, chapter: 3, from: 16, to: 18, version: 'kjv' },
    { book: 'John', bookNumber: 43, chapter: 3, from: 18, to: 20, version: 'kjv' }
  ], true));

  expect(result.ok).toBe(true);
  expect(result.chapterRange).toBe(true);
  expect(result.count).toBe(5);
  expect(result.url).toBe('https://www.blueletterbible.org/kjv/jhn/3/16-20/');
});
