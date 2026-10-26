const { test, expect } = require('./fixtures');

// Regression for selecting point 17 on Substack and invoking BLB Suite.
// The source citation is "Rom. 6:2,6-7,9-11,14,18,22". Every listed
// verse must survive selection parsing; omitted ranges must not be inferred.
test('Substack selection parser preserves all disjoint Romans 6 verse ranges', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '<p><strong>17. </strong><span>He made us free from the power and bondage of sin </span><strong>(Rom. 6:2,6-7,9-11,14,18,22)</strong><span>.</span></p>';
    const verses = extractBibleRefsFromSelectedTextUncached(selected).flatMap(ref => {
      const expanded = [];
      for (let verse = ref.from; verse <= ref.to; verse++) {
        expanded.push({ book: ref.book, chapter: ref.chapter, verse });
      }
      return expanded;
    });
    return [...new Map(verses.map(v => [`${v.book}|${v.chapter}|${v.verse}`, v])).values()];
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 6, verse: 2 },
    { book: 'romans', chapter: 6, verse: 6 },
    { book: 'romans', chapter: 6, verse: 7 },
    { book: 'romans', chapter: 6, verse: 9 },
    { book: 'romans', chapter: 6, verse: 10 },
    { book: 'romans', chapter: 6, verse: 11 },
    { book: 'romans', chapter: 6, verse: 14 },
    { book: 'romans', chapter: 6, verse: 18 },
    { book: 'romans', chapter: 6, verse: 22 }
  ]);
});

test('Substack selection parser preserves the second chapter-qualified 2 Corinthians reference', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '(2 Cor. 1:22, 5:5)';
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to, text: ref.text
    }));
  });

  expect(result).toEqual([
    { book: '2 corinthians', chapter: 1, from: 22, to: 22, text: '2 Cor. 1:22' },
    { book: '2 corinthians', chapter: 5, from: 5, to: 5, text: '5:5' }
  ]);
});

test('Substack selection parser does not absorb the next book number as a verse', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '(Rom. 15:16, 1 Cor. 6:11, 2 Thess. 2:13)';
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to, text: ref.text
    }));
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 15, from: 16, to: 16, text: 'Rom. 15:16' },
    { book: '1 corinthians', chapter: 6, from: 11, to: 11, text: '1 Cor. 6:11' },
    { book: '2 thessalonians', chapter: 2, from: 13, to: 13, text: '2 Thess. 2:13' }
  ]);
});

test('Substack selection parser respects 1, 2, and 3 at numbered-book boundaries', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '(Rom. 1:16, 1 Sam. 3:14, 2 Kings 2:12, 3 John 1:4)';
    return extractBibleRefsFromSelectedTextUncached(selected).map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to
    }));
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 1, from: 16, to: 16 },
    { book: '1 samuel', chapter: 3, from: 14, to: 14 },
    { book: '2 kings', chapter: 2, from: 12, to: 12 },
    { book: '3 john', chapter: 1, from: 4, to: 4 }
  ]);
});

test('Substack selection parser does not reinterpret a later chapter as a verse', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    return extractBibleRefsFromSelectedTextUncached('(Psalms 1:2, 105:1)').map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to
    }));
  });

  expect(result).toEqual([
    { book: 'psalms', chapter: 1, from: 2, to: 2 },
    { book: 'psalms', chapter: 105, from: 1, to: 1 }
  ]);
});

test('Substack selection parser clamps an out-of-range verse to the chapter end', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    return extractBibleRefsFromSelectedTextUncached('(1 Thess. 1:16)').map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to
    }));
  });

  expect(result).toEqual([
    { book: '1 thessalonians', chapter: 1, from: 10, to: 10 }
  ]);
});

test('Substack selection parser never truncates a multi-digit verse number', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    return extractBibleRefsFromSelectedTextUncached('(Rom. 15:16; 1 Cor. 6:11)').map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to, text: ref.text
    }));
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 15, from: 16, to: 16, text: 'Rom. 15:16' },
    { book: '1 corinthians', chapter: 6, from: 11, to: 11, text: '1 Cor. 6:11' }
  ]);
});

// Point 224 in the 250-point list cites the entire chapter, not a single verse.
test('Substack selection parser preserves a chapter-only reference', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    return extractBibleRefsFromSelectedTextUncached('(1 Tim. 5)').map(ref => ({
      book: ref.book, chapter: ref.chapter, from: ref.from, to: ref.to
    }));
  });

  expect(result).toEqual([
    { book: '1 timothy', chapter: 5, from: null, to: null }
  ]);
});

// Point 250 includes both an abbreviated comma-separated range and an explicit range.
test('Substack selection parser preserves the extended-list Isaiah and Hebrews citations', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '(Isa. 55:10,11; Hebrews 5:12-14)';
    const verses = extractBibleRefsFromSelectedTextUncached(selected).flatMap(ref => {
      // Chapter-only references are not expected in this test.
      const expanded = [];
      for (let verse = ref.from; verse <= ref.to; verse++) {
        expanded.push({ book: ref.book, chapter: ref.chapter, verse });
      }
      return expanded;
    });
    return [...new Map(verses.map(v => [`${v.book}|${v.chapter}|${v.verse}`, v])).values()];
  });

  expect(result).toEqual([
    { book: 'isaiah', chapter: 55, verse: 10 },
    { book: 'isaiah', chapter: 55, verse: 11 },
    { book: 'hebrews', chapter: 5, verse: 12 },
    { book: 'hebrews', chapter: 5, verse: 13 },
    { book: 'hebrews', chapter: 5, verse: 14 }
  ]);
});
