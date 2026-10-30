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
    ].join('\n');
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
    return extractBibleRefsFromSelectedTextUncached('Romans 8\nRomans 8:1').map(ref => ({
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

test('Facebook post selection extracts references split across separate post text blocks', async ({ extensionWorker }) => {
  // Mirrors the selected reference-bearing lines in the supplied Facebook post.
  // Each entry represents a separate dir="auto" text block in the post DOM.
  const result = await extensionWorker.evaluate(() => {
    const selectedBlocks = [
      'Mt.10:32-33',
      'Lk.12:33',
      'Romans 9-11',
      'Romans 16:25',
      'Eph. 3',
      'Col. 1:24-27',
      'Eph.3:1-3',
      '2 Tim.2:12',
      'Romans 1-5',
      'Mt.16:24-27',
      'Lk.21:36',
      'Romans 4:4-5',
      'Romans 8:17',
      'Romans14:10-12',
      '1Cor. 3: 5-15',
      '1Cor. 9:14-27',
      '2Cor. 5: 9-10',
      '2Cor. 9:6-7',
      'Phil. 3:10-14',
      'Phil.4:15-17',
      'Col. 2:4,8,18',
      'Col.3:23-25',
      '2Tim.2:10-15',
      'Titus 3:8'
    ];
    return extractBibleRefsFromSelectedTextUncached(selectedBlocks.join('\n')).map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from ?? null, to: ref.to ?? null
    }));
  });

  // Chapter-only ranges expand to every chapter, and comma-separated verses
  // remain separate reference entries; the output therefore exceeds 24 blocks.
  expect(result.length).toBeGreaterThanOrEqual(24);
  expect([...new Set(result.map(ref => ref.book))]).toEqual([
    'matthew','luke','romans','ephesians','colossians','2 timothy',
    '1 corinthians','2 corinthians','philippians','titus'
  ]);
  expect(result.filter(ref => ref.book === 'romans' && [9,10,11].includes(ref.chapter))
    .map(ref => ref.chapter)).toEqual([9,10,11]);
  expect(result.filter(ref => ref.book === 'romans' && [1,2,3,4,5].includes(ref.chapter))
    .map(ref => ref.chapter)).toEqual([1,2,3,4,5]);
  expect(result.filter(ref => ref.book === 'colossians' && ref.chapter === 2)
    .map(ref => ref.from)).toEqual([4,8,18]);
});
