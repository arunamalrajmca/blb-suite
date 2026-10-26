const { test, expect } = require('./fixtures');

// Regression for selecting point 17 on Substack and invoking BLB Suite.
// The source citation is "Rom. 6:2,6-7,9-11,14,18,22". Every listed
// verse must survive selection parsing; omitted ranges must not be inferred.
test('Substack selection parser preserves all disjoint Romans 6 verse ranges', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const selected = '<p><strong>17. </strong><span>He made us free from the power and bondage of sin </span><strong>(Rom. 6:2,6-7,9-11,14,18,22)</strong><span>.</span></p>';
    return extractBibleRefsFromSelectedTextUncached(selected).flatMap(ref => {
      const verses = [];
      for (let verse = ref.from; verse <= ref.to; verse++) {
        verses.push({ book: ref.book, chapter: ref.chapter, verse });
      }
      return verses;
    });
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
    return extractBibleRefsFromSelectedTextUncached(selected).flatMap(ref => {
      const verses = [];
      for (let verse = ref.from; verse <= ref.to; verse++) {
        verses.push({ book: ref.book, chapter: ref.chapter, verse });
      }
      return verses;
    });
  });

  expect(result).toEqual([
    { book: '2 corinthians', chapter: 1, verse: 22 },
    { book: '2 corinthians', chapter: 5, verse: 5 }
  ]);
});
