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
    // Parser passes may represent the same explicit verse in overlapping
    // ranges. This regression checks the unique verse set, not range grouping.
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


// Regression for selecting point 75 on Substack and invoking BLB Suite.
// Both references are explicitly chapter-qualified: "2 Cor. 1:22, 5:5".
test('Substack selection parser preserves the second chapter-qualified 2 Corinthians reference', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '<p><strong>75. </strong><span>He is God’s earnest, the non-refundable deposit, if you will, of God’s purchased possession forever </span><strong>(2 Cor. 1:22, 5:5)</strong><span>.</span></p>';
    const verses = extractBibleRefsFromSelectedTextUncached(selected).flatMap(ref => {
      const expanded = [];
      for (let verse = ref.from; verse <= ref.to; verse++) {
        expanded.push({ book: ref.book, chapter: ref.chapter, verse });
      }
      return expanded;
    });
    // Parser passes may represent the same explicit verse in overlapping
    // ranges. This regression checks the unique verse set, not range grouping.
    return [...new Map(verses.map(v => [`${v.book}|${v.chapter}|${v.verse}`, v])).values()];
  });

  expect(result).toEqual([
    { book: '2 corinthians', chapter: 1, verse: 22 },
    { book: '2 corinthians', chapter: 5, verse: 5 }
  ]);
});

// Regression for a new numbered book after a comma. The leading "2" in
// "2 Thess. 2:13" must not be parsed as 1 Corinthians 6:2.
test('Substack selection parser does not absorb the next book number as a verse', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '<p><strong>53. </strong><span>He sets us apart for God’s good use </span><strong>(Rom. 15:16, 1 Cor. 6:11, 2 Thess. 2:13)</strong><span>.</span></p>';
    return extractBibleRefsFromSelectedTextUncached(selected).flatMap(ref => {
      const verses = [];
      for (let verse = ref.from; verse <= ref.to; verse++) {
        verses.push({ book: ref.book, chapter: ref.chapter, verse });
      }
      return verses;
    });
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 15, verse: 16 },
    { book: '1 corinthians', chapter: 6, verse: 11 },
    { book: '2 thessalonians', chapter: 2, verse: 13 }
  ]);
});

// Regression for all numbered-book prefixes: the leading 1, 2, or 3 in
// the next book name must not be reused as a truncated prior verse.
test('Substack selection parser respects 1, 2, and 3 at numbered-book boundaries', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '(Rom. 1:16, 1 Sam. 3:14, 2 Kings 2:12, 3 John 1:4)';
    return extractBibleRefsFromSelectedTextUncached(selected).flatMap(ref => {
      const verses = [];
      for (let verse = ref.from; verse <= ref.to; verse++) {
        verses.push({ book: ref.book, chapter: ref.chapter, verse });
      }
      return verses;
    });
  });

  expect(result).toEqual([
    { book: 'romans', chapter: 1, verse: 16 },
    { book: '1 samuel', chapter: 3, verse: 14 },
    { book: '2 kings', chapter: 2, verse: 12 },
    { book: '3 john', chapter: 1, verse: 4 }
  ]);
});
