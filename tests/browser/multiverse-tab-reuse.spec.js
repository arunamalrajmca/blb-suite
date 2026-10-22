const { test, expect } = require('./fixtures');

// Genesis 42–46 plus Genesis 48–49 exceeds BLB's 200-verse MultiVerse limit,
// producing two batches: the first 200 verses and the remaining verses.
const SELECTION = [
  { book: 'Genesis', bookNumber: 1, chapter: 42, from: 1, to: 38, version: 'kjv' },
  { book: 'Genesis', bookNumber: 1, chapter: 43, from: 1, to: 34, version: 'kjv' },
  { book: 'Genesis', bookNumber: 1, chapter: 44, from: 1, to: 34, version: 'kjv' },
  { book: 'Genesis', bookNumber: 1, chapter: 45, from: 1, to: 28, version: 'kjv' },
  { book: 'Genesis', bookNumber: 1, chapter: 46, from: 1, to: 34, version: 'kjv' },
  { book: 'Genesis', bookNumber: 1, chapter: 48, from: 1, to: 22, version: 'kjv' },
  { book: 'Genesis', bookNumber: 1, chapter: 49, from: 1, to: 26, version: 'kjv' }
];

async function openMultiVerse(extensionWorker, refs) {
  // This code already runs inside the extension service worker. Sending a
  // runtime message from that worker does not dispatch it back to its own
  // onMessage listener, so call the shared production entry point directly.
  return extensionWorker.evaluate(async payload => openBlbMultiVerseRefs(payload, true), refs);
}

function countSubmittedVerses(mvText) {
  let total = 0;
  for (const match of String(mvText || '').matchAll(/:\s*(\d+)(?:\s*-\s*(\d+))?/g)) {
    const from = Number(match[1]);
    const to = match[2] == null ? from : Number(match[2]);
    total += Math.max(0, to - from + 1);
  }
  return total;
}

async function getTrackedMultiVerseTabs(extensionWorker, tabIds = []) {
  return extensionWorker.evaluate(async ids => {
    // A successful opener returns while the tab may still be on the extension
    // POST handoff page. Inspect the exact returned tab IDs rather than
    // filtering only committed BLB URLs, which can hide valid reservations.
    const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id).catch(() => null)));
    const data = await chrome.storage.local.get({ blbSuiteMultiVerseTabSets: {} });
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    return tabs.filter(Boolean).map(tab => ({
      id: tab.id,
      url: tab.url || '',
      pendingUrl: tab.pendingUrl || '',
      key: tracked[String(tab.id)]?.key || null
    }));
  }, tabIds);
}

test('independent MultiVerse commands start opening tabs without waiting for earlier command completion', async ({ context, extensionWorker }) => {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>MultiVerse concurrency fixture</title></head><body>MultiVerse fixture</body></html>'
  }));

  const outcome = await extensionWorker.evaluate(async () => {
    const original = openBlbMultiVerseRefsSingleBatch;
    let calls = 0;
    let firstEnteredResolve;
    let secondEnteredResolve;
    let releaseFirstResolve;
    const firstEntered = new Promise(resolve => { firstEnteredResolve = resolve; });
    const secondEntered = new Promise(resolve => { secondEnteredResolve = resolve; });
    const firstGate = new Promise(resolve => { releaseFirstResolve = resolve; });

    openBlbMultiVerseRefsSingleBatch = async (...args) => {
      calls++;
      if (calls === 1) {
        firstEnteredResolve();
        await firstGate;
      } else if (calls === 2) {
        secondEnteredResolve();
      }
      return original(...args);
    };

    const refsA = [{ book:'Genesis', bookNumber:1, chapter:1, from:1, to:1, version:'kjv' },
                   { book:'Genesis', bookNumber:1, chapter:1, from:2, to:2, version:'kjv' }];
    const refsB = [{ book:'John', bookNumber:43, chapter:1, from:1, to:1, version:'niv' },
                   { book:'John', bookNumber:43, chapter:1, from:2, to:2, version:'niv' }];

    try {
      const first = openBlbMultiVerseRefs(refsA, false);
      await firstEntered;
      const second = openBlbMultiVerseRefs(refsB, false);
      const secondStarted = await Promise.race([
        secondEntered.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 250))
      ]);
      releaseFirstResolve();
      const results = await Promise.all([first, second]);
      return { secondStarted, firstOk:results[0]?.ok, secondOk:results[1]?.ok };
    } finally {
      releaseFirstResolve();
      openBlbMultiVerseRefsSingleBatch = original;
    }
  });

  expect(outcome.secondStarted, 'the second request must enter batch opening before the first request is released').toBe(true);
  expect(outcome.firstOk).toBe(true);
  expect(outcome.secondOk).toBe(true);
});

test('MultiVerse reuses both 200-verse batches when the same selection is repeated or reordered', async ({ context, extensionWorker }) => {
  const submittedPayloads = [];
  await context.route('https://www.blueletterbible.org/**', route => {
    if (route.request().method() === 'POST') {
      const body = new URLSearchParams(route.request().postData() || '');
      submittedPayloads.push(body.get('mvText') || '');
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    });
  });

  const first = await openMultiVerse(extensionWorker, SELECTION);
  expect(first?.ok).toBe(true);
  expect(first.batchCount).toBe(2);
  expect(first.tabIds).toHaveLength(2);
  expect(first.tabIds[0]).not.toBe(first.tabIds[1]);

  const repeated = await openMultiVerse(extensionWorker, SELECTION);
  expect(repeated?.ok).toBe(true);
  expect(repeated.batchCount).toBe(2);
  expect(repeated.tabIds).toEqual(first.tabIds);

  // canonicalMultiVerseSet should normalize reference ordering before batches
  // are formed, so reversing the input refs must reuse the same two batches.
  const reversed = await openMultiVerse(extensionWorker, [...SELECTION].reverse());
  expect(reversed?.ok).toBe(true);
  expect(reversed.batchCount).toBe(2);
  expect(reversed.tabIds).toEqual(first.tabIds);

  // The same and reordered selections must reuse their reservations even if
  // the initial POST handoffs have not both completed. Waiting here would mask
  // a race that can create duplicate tabs during the handoff navigation.
  await expect.poll(() => submittedPayloads.length, { timeout: 20000 }).toBe(2);

  const trackedTabs = await getTrackedMultiVerseTabs(extensionWorker, first.tabIds);
  expect(new Set(trackedTabs.map(tab => tab.id))).toEqual(new Set(first.tabIds));
  expect(trackedTabs.every(tab => tab.key), JSON.stringify(trackedTabs, null, 2)).toBe(true);
  expect(new Set(trackedTabs.map(tab => tab.key)).size).toBe(2);
});

test('MultiVerse opens every batch for requests exceeding 20 tabs', async ({ context, extensionWorker }) => {
  const submittedPayloads = [];
  await context.route('https://www.blueletterbible.org/**', route => {
    if (route.request().method() === 'POST') {
      const body = new URLSearchParams(route.request().postData() || '');
      submittedPayloads.push(body.get('mvText') || '');
    }
    return route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    });
  });

  // Build 4,201 distinct valid KJV verse references from the bundled canon.
  // This requires 22 batches at the production limit of 200 verses per tab.
  const result = await extensionWorker.evaluate(async () => {
    const refs = [];
    for (const book of bookData) {
      for (let chapter = 1; chapter <= book.chapterCount && refs.length < 4201; chapter++) {
        const verseCount = Number(book.verses[chapter - 1] || 0);
        for (let verse = 1; verse <= verseCount && refs.length < 4201; verse++) {
          refs.push({
            book: book.name,
            bookNumber: Number(book.bookNumber),
            chapter,
            from: verse,
            to: verse,
            version: 'kjv'
          });
        }
      }
      if (refs.length >= 4201) break;
    }
    const opened = await openBlbMultiVerseRefs(refs, true);
    return { requestedVerseCount: refs.length, opened };
  });

  expect(result.requestedVerseCount).toBe(4201);
  expect(result.opened?.ok, JSON.stringify(result.opened)).toBe(true);
  expect(result.opened.count).toBe(4201);
  expect(result.opened.batchCount).toBe(22);
  expect(result.opened.tabIds).toHaveLength(22);
  expect(new Set(result.opened.tabIds).size).toBe(22);
  expect(result.opened.truncated).toBe(false);

  // Confirm all returned tabs still exist after the final batch has been
  // created, are uniquely tracked, and are progressing through the POST
  // handoff or have reached the mocked BLB destination.
  const liveState = await extensionWorker.evaluate(async ids => {
    const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id).catch(() => null)));
    const data = await chrome.storage.local.get({ blbSuiteMultiVerseTabSets: {} });
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    return tabs.map(tab => tab && ({
      id: tab.id,
      url: tab.url || '',
      pendingUrl: tab.pendingUrl || '',
      key: tracked[String(tab.id)]?.key || null
    }));
  }, result.opened.tabIds);
  expect(liveState.filter(Boolean), JSON.stringify(liveState, null, 2)).toHaveLength(22);
  expect(new Set(liveState.map(tab => tab.id)).size).toBe(22);
  expect(liveState.every(tab => tab.key), JSON.stringify(liveState, null, 2)).toBe(true);
  expect(new Set(liveState.map(tab => tab.key)).size).toBe(22);
  const expectedDestination = value =>
    /^(?:chrome|moz)-extension:\/\//i.test(value) ||
    /blueletterbible\.org\/(?:tools\/MultiVerse\.cfm|search\/search\.cfm)/i.test(value);
  expect(liveState.every(tab =>
    expectedDestination(tab.url) || expectedDestination(tab.pendingUrl)
  ), JSON.stringify(liveState, null, 2)).toBe(true);

  // 4,201 verses must be submitted as 21 full batches plus one final verse.
  await expect.poll(() => submittedPayloads.length, { timeout: 50000 }).toBe(22);
  expect(submittedPayloads.map(countSubmittedVerses).sort((a, b) => b - a))
    .toEqual([...Array(21).fill(200), 1]);
});

test('case-sensitive gods search opens and reuses both batches', async ({ context, extensionWorker }) => {
  const submittedPayloads = [];
  await context.route('https://www.blueletterbible.org/**', route => {
    if (route.request().method() === 'POST') {
      const body = new URLSearchParams(route.request().postData() || '');
      submittedPayloads.push(body.get('mvText') || '');
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    });
  });

  const first = await extensionWorker.evaluate(async () => {
    const originalOpenMultiVerse = openBlbMultiVerseRefs;
    const openResults = [];
    openBlbMultiVerseRefs = async (...args) => {
      const result = await originalOpenMultiVerse(...args);
      openResults.push(result);
      return result;
    };
    let handled;
    try {
      handled = await handleCaseSensitiveBCommand('gods', 'newForegroundTab');
    } finally {
      openBlbMultiVerseRefs = originalOpenMultiVerse;
    }
    const tabs = await chrome.tabs.query({});
    const data = await chrome.storage.local.get({blbSuiteMultiVerseTabSets:{}});
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    return {
      handled,
      openResults,
      tabs: tabs.map(tab => ({
        id:tab.id,
        url:tab.url || '',
        trackedKey:tracked[String(tab.id)]?.key || null
      }))
    };
  });
  expect(first.handled).toBe(true);
  expect(first.openResults).toHaveLength(1);
  expect(first.openResults[0]?.ok, JSON.stringify(first.openResults)).toBe(true);
  expect(first.openResults[0]?.batchCount, JSON.stringify(first.openResults)).toBe(2);
  expect(first.openResults[0]?.tabIds, JSON.stringify(first.openResults)).toHaveLength(2);
  const firstTrackedTabs = first.tabs.filter(tab => tab.trackedKey);
  expect(firstTrackedTabs, JSON.stringify({openResults:first.openResults,tabs:first.tabs})).toHaveLength(2);
  expect(firstTrackedTabs[0].id).not.toBe(firstTrackedTabs[1].id);
  expect(new Set(firstTrackedTabs.map(tab => tab.trackedKey)).size).toBe(2);
  await expect.poll(() => submittedPayloads.length).toBe(2);
  expect(submittedPayloads.map(countSubmittedVerses).sort((a,b) => b-a)).toEqual([200,14]);

  const repeated = await extensionWorker.evaluate(async () => {
    await handleCaseSensitiveBCommand('gods', 'newForegroundTab');
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.blueletterbible.org/tools/MultiVerse.cfm*',
        'https://www.blueletterbible.org/search/search.cfm?*blbSuiteMultiVerse=1*'
      ]
    });
    const data = await chrome.storage.local.get({blbSuiteMultiVerseTabSets:{}});
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    return tabs.filter(tab => tracked[String(tab.id)]?.key)
      .map(tab => ({id:tab.id, key:tracked[String(tab.id)].key}));
  });
  expect(repeated.map(tab => tab.id).sort()).toEqual(firstTrackedTabs.map(tab => tab.id).sort());
  expect(submittedPayloads.map(countSubmittedVerses).sort((a,b) => b-a)).toEqual([200,14]);
});

test('b v1 reuses its originating tab and leaves no blank command tab', async ({ context, extensionWorker }) => {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
  }));

  const result = await extensionWorker.evaluate(async () => {
    const origin = await chrome.tabs.create({url:'about:blank', active:true});
    await handleBCommand('v1', 'currentTab');
    const tabs = await chrome.tabs.query({});
    const originAfter = await chrome.tabs.get(origin.id).catch(() => null);
    const data = await chrome.storage.local.get({blbSuiteMultiVerseTabSets:{}});
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    return {
      originId:origin.id,
      originUrl:originAfter?.url || null,
      blankTabs:tabs.filter(tab => /^about:blank(?:[#?].*)?$/i.test(String(tab.url || ''))).map(tab => tab.id),
      trackedIds:tabs.filter(tab => tracked[String(tab.id)]?.key).map(tab => tab.id)
    };
  });

  // The originating tab first loads multiverse-post.html to submit the form.
  // Wait for the POST navigation instead of asserting the intermediate URL.
  await expect.poll(() => extensionWorker.evaluate(async id =>
    (await chrome.tabs.get(id).catch(() => null))?.url || '', result.originId),
    {timeout:15000}
  ).toContain('blueletterbible.org/tools/MultiVerse.cfm');
  expect(result.blankTabs).not.toContain(result.originId);
  expect(result.trackedIds).toContain(result.originId);
});

test('case-sensitive search reuses the originating tab and leaves no blank orphan', async ({ context, extensionWorker }) => {
  const submittedPayloads = [];
  await context.route('https://www.blueletterbible.org/**', route => {
    if (route.request().method() === 'POST') {
      const body = new URLSearchParams(route.request().postData() || '');
      submittedPayloads.push(body.get('mvText') || '');
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    });
  });

  const result = await extensionWorker.evaluate(async () => {
    const origin = await chrome.tabs.create({url:'about:blank', active:true});
    const handled = await handleCaseSensitiveBCommand('gods', 'currentTab');
    await new Promise(resolve => setTimeout(resolve, 100));
    const allTabs = await chrome.tabs.query({});
    const data = await chrome.storage.local.get({blbSuiteMultiVerseTabSets:{}});
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    return {
      handled,
      originId:origin.id,
      originUrl:(await chrome.tabs.get(origin.id)).url,
      blankTabs:allTabs.filter(tab => /^about:blank(?:[#?].*)?$/i.test(String(tab.url || ''))).map(tab => tab.id),
      tracked:allTabs.filter(tab => tracked[String(tab.id)]?.key).map(tab => ({
        id:tab.id,
        key:tracked[String(tab.id)].key
      }))
    };
  });
  expect(result.handled).toBe(true);
  // The first batch uses the handoff page before its POST reaches BLB. The
  // queue intentionally spaces submissions, so 100 ms is not enough to
  // observe the final URL reliably.
  await expect.poll(() => extensionWorker.evaluate(async id =>
    (await chrome.tabs.get(id).catch(() => null))?.url || '', result.originId),
    {timeout:15000}
  ).toContain('blueletterbible.org/tools/MultiVerse.cfm');
  expect(result.blankTabs).not.toContain(result.originId);
  expect(result.tracked.map(tab => tab.id)).toContain(result.originId);
  await expect.poll(() => submittedPayloads.length).toBe(2);
  expect(submittedPayloads.map(countSubmittedVerses).sort((a,b) => b-a)).toEqual([200,14]);

  // If the same search is launched from another blank command tab, reuse the
  // existing result batches and close only that empty launcher tab.
  const repeated = await extensionWorker.evaluate(async () => {
    const origin = await chrome.tabs.create({url:'about:blank', active:true});
    await handleCaseSensitiveBCommand('gods', 'currentTab');
    const originAfter = await chrome.tabs.get(origin.id).catch(() => null);
    const tabs = await chrome.tabs.query({});
    const data = await chrome.storage.local.get({blbSuiteMultiVerseTabSets:{}});
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    return {
      originId:origin.id,
      originExists:!!originAfter,
      blankIds:tabs.filter(tab => /^about:blank(?:[#?].*)?$/i.test(String(tab.url || ''))).map(tab => tab.id),
      trackedIds:tabs.filter(tab => tracked[String(tab.id)]?.key).map(tab => tab.id)
    };
  });
  expect(repeated.originExists).toBe(false);
  expect(repeated.blankIds).not.toContain(repeated.originId);
  expect(new Set(repeated.trackedIds)).toEqual(new Set(result.tracked.map(tab => tab.id)));
});

test('case-sensitive apostrophe search finds all capitalization variants with an incomplete index', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const corpus = [
      [1, 1, 1, "LORD'S is uppercase"],
      [1, 1, 2, "Lord's is title case"],
      [1, 1, 3, "lord's is lowercase"],
      [1, 1, 4, "children's books"],
      [1, 1, 5, "Children's books"],
      [1, 1, 6, "CHILDREN'S books"]
    ];
    // Apostrophe searches must not depend on a complete candidate index.
    const incompleteIndex = { "LORD'S": [0] };
    const search = query => BLBCaseSensitiveCore.searchCaseSensitiveCorpus(
      query, corpus, incompleteIndex
    ).map(entry => entry[2]);
    return {
      lordsUpper: search("LORD'S"),
      lordsUpperLowerSuffix: search("LORD's"),
      lordsTitle: search("Lord's"),
      lordsLower: search("lord's"),
      childrensLower: search("children's"),
      childrensTitle: search("Children's"),
      childrensUpper: search("CHILDREN'S")
    };
  });

  expect(result.lordsUpper).toEqual([1]);
  // The grammatical possessive suffix's s/S is not a capitalization
  // distinction; the base word's case remains exact.
  expect(result.lordsUpperLowerSuffix).toEqual([1]);
  expect(result.lordsTitle).toEqual([2]);
  expect(result.lordsLower).toEqual([3]);
  expect(result.childrensLower).toEqual([4]);
  expect(result.childrensTitle).toEqual([5]);
  expect(result.childrensUpper).toEqual([6]);
});

test('case-sensitive apostrophe queries preserve exact capitalization and avoid native fallback', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(async () => {
    const originalSearch = BLBCaseSensitiveCore.searchCaseSensitiveCorpus;
    const originalNativeSearch = openCaseSensitiveNativeSearch;
    const originalOpenSingle = openSingleKjvVerse;
    const localQueries = [];
    const nativeQueries = [];
    const openedRefs = [];
    const queries = ["LORD's", "Lord's", "lord's", "CHILDREN'S", "Children's", "children's"];
    const verseByQuery = new Map(queries.map((query, index) => [query, index + 1]));

    try {
      BLBCaseSensitiveCore.searchCaseSensitiveCorpus = query => {
        localQueries.push(query);
        return [[1, 1, verseByQuery.get(query), query]];
      };
      openCaseSensitiveNativeSearch = async query => {
        nativeQueries.push(query);
      };
      openSingleKjvVerse = async ref => {
        openedRefs.push(ref);
      };

      for (const query of queries) {
        await handleCaseSensitiveBCommand(query, 'currentTab');
      }
    } finally {
      BLBCaseSensitiveCore.searchCaseSensitiveCorpus = originalSearch;
      openCaseSensitiveNativeSearch = originalNativeSearch;
      openSingleKjvVerse = originalOpenSingle;
    }

    return {localQueries, nativeQueries, openedRefs};
  });

  expect(result.localQueries).toEqual(["LORD's", "Lord's", "lord's", "CHILDREN'S", "Children's", "children's"]);
  expect(result.nativeQueries).toEqual([]);
  expect(result.openedRefs).toEqual([
    [1, 1, 1], [1, 1, 2], [1, 1, 3],
    [1, 1, 4], [1, 1, 5], [1, 1, 6]
  ]);
});

test('case-sensitive searches without apostrophes retain indexed candidate behavior', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => {
    const corpus = [
      [1, 1, 1, "LORD appears"],
      [1, 1, 2, "Lord appears"],
      [1, 1, 3, "lord appears"],
      [1, 1, 4, "God and Spirit"],
      [1, 1, 5, "GOD and SPIRIT"],
      [1, 1, 6, "god and spirit"]
    ];
    const index = {
      LORD: [0], Lord: [1], lord: [2],
      God: [3], GOD: [4], god: [5]
    };
    const search = query => BLBCaseSensitiveCore.searchCaseSensitiveCorpus(
      query, corpus, index
    ).map(entry => entry[2]);
    return {
      lordUpper: search("LORD"),
      lordTitle: search("Lord"),
      lordLower: search("lord"),
      phraseTitle: search("God and Spirit"),
      phraseUpper: search("GOD and SPIRIT"),
      phraseLower: search("god and spirit")
    };
  });

  expect(result.lordUpper).toEqual([1]);
  expect(result.lordTitle).toEqual([2]);
  expect(result.lordLower).toEqual([3]);
  expect(result.phraseTitle).toEqual([4]);
  expect(result.phraseUpper).toEqual([5]);
  expect(result.phraseLower).toEqual([6]);
});


test('case-sensitive Boolean fallback handles possessive apostrophes', async ({ extensionWorker }) => {
  const result = await extensionWorker.evaluate(() => ({
    normalizedPossessive: normalizeBooleanOperatorsOutsideQuotes("LORD'S and God"),
    detectsPossessiveBoolean: hasUnquotedBooleanOperator("LORD'S AND God"),
    normalizedQuotedPhrase: normalizeBooleanOperatorsOutsideQuotes(`"LORD'S and God"`),
    ignoresQuotedBoolean: hasUnquotedBooleanOperator(`"LORD'S AND God"`)
  }));
  expect(result.normalizedPossessive).toBe("LORD'S AND God");
  expect(result.detectsPossessiveBoolean).toBe(true);
  expect(result.normalizedQuotedPhrase).toBe(`"LORD'S and God"`);
  expect(result.ignoresQuotedBoolean).toBe(false);
});

test('MultiVerse submits all verses for a chapter-only ref in a mixed selection', async ({ context, extensionWorker }) => {
  const submittedPayloads = [];
  await context.route('https://www.blueletterbible.org/**', route => {
    if (route.request().method() === 'POST') {
      const body = new URLSearchParams(route.request().postData() || '');
      submittedPayloads.push(body.get('mvText') || '');
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse chapter regression</title></head><body>MultiVerse fixture</body></html>'
    });
  });

  const refs = [
    { book: 'Matthew', bookNumber: 40, chapter: 5, from: 3, to: 12, version: 'kjv' },
    { book: 'Romans', bookNumber: 45, chapter: 8, from: null, to: null, text: 'Romans 8', version: 'kjv' },
    { book: '1 Peter', bookNumber: 60, chapter: 2, from: 9, to: 10, version: 'kjv' }
  ];
  const result = await openMultiVerse(extensionWorker, refs);

  expect(result?.ok, JSON.stringify(result)).toBe(true);
  expect(result.count).toBe(10 + 39 + 2);
  expect(result.batchCount).toBe(1);
  await expect.poll(() => submittedPayloads.length, { timeout: 15000 }).toBe(1);

  const submitted = submittedPayloads[0].toLowerCase();
  expect(submitted).toContain('matthew 5:3-12');
  expect(submitted).toContain('romans 8:1-39');
  expect(submitted).toContain('1 peter 2:9-10');
  expect(countSubmittedVerses(submitted)).toBe(51);
});



test('mixed chapter-only selection submits all 51 expected verses through the selection entry point', async ({ context, extensionWorker }) => {
  const submittedPayloads = [];
  await context.route('https://www.blueletterbible.org/**', route => {
    if (route.request().method() === 'POST') {
      const body = new URLSearchParams(route.request().postData() || '');
      submittedPayloads.push((body.get('mvText') || '').toLowerCase());
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    });
  });

  const result = await extensionWorker.evaluate(async () => {
    const selection = 'Matthew 5:3-12\nRomans 8\n1 Peter 2:9-10';
    const refs = extractBibleRefsFromSelectedTextUncached(normalizeSelectedScriptureText(selection));
    const opened = await openBlbPageSelection(selection, {activeIfNew:true, activateExisting:true});
    return {
      refs: refs.map(ref => ({
        book: ref.book,
        chapter: ref.chapter,
        from: ref.from ?? null,
        to: ref.to ?? null
      })),
      opened
    };
  });

  expect(result.refs).toEqual([
    { book: 'matthew', chapter: 5, from: 3, to: 12 },
    { book: 'romans', chapter: 8, from: null, to: null },
    { book: '1 peter', chapter: 2, from: 9, to: 10 }
  ]);
  expect(result.opened?.ok, JSON.stringify(result.opened)).toBe(true);
  await expect.poll(() => submittedPayloads.length, { timeout: 10000 }).toBe(1);
  expect(submittedPayloads[0]).toContain('matthew 5:3-12');
  expect(submittedPayloads[0]).toContain('romans 8:1-39');
  expect(submittedPayloads[0]).toContain('1 peter 2:9-10');
  expect(countSubmittedVerses(submittedPayloads[0])).toBe(51);
});
