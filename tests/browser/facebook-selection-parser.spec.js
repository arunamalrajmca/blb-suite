const { test, expect } = require('./fixtures');

test('Facebook selection parser preserves numbered-book references across invisible Unicode marks', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = [
      'Acts 16:1-3',
      'Romans 16:21',
      '1\u200f Corinthians 4:17',
      'Philippians 2:19-22',
      'Colossians 1:1'
    ].join('\n');
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from,
      to: ref.to
    }));
  });

  expect(result).toEqual([
    { book: 'acts', chapter: 16, from: 1, to: 3 },
    { book: 'romans', chapter: 16, from: 21, to: 21 },
    { book: '1 corinthians', chapter: 4, from: 17, to: 17 },
    { book: 'philippians', chapter: 2, from: 19, to: 22 },
    { book: 'colossians', chapter: 1, from: 1, to: 1 }
  ]);
});

test('Facebook selection parser retains every reference in a clean multi-book selection', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = [
      'Romans 16:21',
      '1 Corinthians 4:17',
      'Philippians 2:19-22'
    ].join('\n');
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from,
      to: ref.to
    }));
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 16, from: 21, to: 21 },
    { book: '1 corinthians', chapter: 4, from: 17, to: 17 },
    { book: 'philippians', chapter: 2, from: 19, to: 22 }
  ]);
});
