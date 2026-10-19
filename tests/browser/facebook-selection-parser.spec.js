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

test('Facebook selection parser preserves numbered books after normalization collapses verse-ending whitespace', async ({ extensionWorker }) => {
  const cases = [
    ['Romans 16:21', '1 Corinthians 4:17', 'Philippians 2:19-22'],
    ['Romans 16:22', '2 Corinthians 13:14', 'Galatians 6:18'],
    ['Romans 16:23', '3 John 1:4', 'Jude 1:5']
  ];
  const results = await extensionWorker.evaluate(cases => cases.map(lines => {
    const normalized = normalizeSelectedScriptureText(lines.join('\n'));
    return extractBibleRefsFromSelectedTextUncached(normalized).map(ref => ref.book);
  }), cases);

  expect(results[0]).toEqual(['romans', '1 corinthians', 'philippians']);
  expect(results[1]).toEqual(['romans', '2 corinthians', 'galatians']);
  expect(results[2]).toEqual(['romans', '3 john', 'jude']);
});

test('Facebook selection parser preserves references across the reported reordered selection combinations', async ({ extensionWorker }) => {
  const cases = [
    ['Romans 16:21', '1 Corinthians 4:17', 'Philippians 2:19-22'],
    ['1 Corinthians 4:17', 'Philippians 2:19-22'],
    ['Philippians 2:19-22', 'Colossians 1:1', 'Romans 16:21', '1 Corinthians 4:17'],
    ['Romans 16:21', '1 Corinthians 4:17', 'Philippians 2:19-22', 'Colossians 1:1', 'Acts 16:1-3']
  ];
  const results = await extensionWorker.evaluate(cases => cases.map(lines =>
    extractBibleRefsFromSelectedTextUncached(lines.join('\n')).map(ref => ref.book)
  ), cases);

  expect(results[0]).toEqual(['romans', '1 corinthians', 'philippians']);
  expect(results[1]).toEqual(['1 corinthians', 'philippians']);
  expect(results[2]).toEqual(['philippians', 'colossians', 'romans', '1 corinthians']);
  expect(results[3]).toEqual(['romans', '1 corinthians', 'philippians', 'colossians', 'acts']);
});

test('Facebook selection parser preserves chapter-only refs alongside adjacent verse refs', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = [
      'Matthew 5:3-12',
      'Romans 8',
      '1 Peter 2:9-10'
    ].join('\\n');
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from ?? null,
      to: ref.to ?? null
    }));
  });

  expect(result).toEqual([
    { book: 'matthew', chapter: 5, from: 3, to: 12 },
    { book: 'romans', chapter: 8, from: null, to: null },
    { book: '1 peter', chapter: 2, from: 9, to: 10 }
  ]);
});

test('Facebook selection parser keeps a chapter ref distinct from explicit verse one', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    return extractBibleRefsFromSelectedTextUncached('Romans 8\\nRomans 8:1').map(ref => ({
      book: ref.book,
      chapter: ref.chapter,
      from: ref.from ?? null,
      to: ref.to ?? null
    }));
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 8, from: null, to: null },
    { book: 'romans', chapter: 8, from: 1, to: 1 }
  ]);
});
