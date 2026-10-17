const { test, expect } = require('./fixtures');

// Genesis 42–46 plus Genesis 48–49 exceeds BLB's 200-verse MultiVerse limit,
// producing two batches: the first 200 verses and the remaining verses.
const SELECTION = [
  { book: 'Genesis', bookNumber: 1, chapter: 42, from: 1, to: 38, version: 'kjv' },
  { bookNumber: 1, chapter: 43, from: 1, to: 34, version: 'kjv' },
  { bookNumber: 1, chapter: 44, from: 1, to: 34, version: 'kjv' },
  { bookNumber: 1, chapter: 45, from: 1, to: 28, version: 'kjv' },
  { bookNumber: 1, chapter: 46, from: 1, to: 34, version: 'kjv' },
  { bookNumber: 1, chapter: 48, from: 1, to: 22, version: 'kjv' },
  { bookNumber: 1, chapter: 49, from: 1, to: 26, version: 'kjv' }
];

async function openMultiVerse(extensionWorker, refs) {
  // This code already runs inside the extension service worker. Sending a
  // runtime message from that worker does not dispatch it back to its own
  // onMessage listener, so call the shared production entry point directly.
  return extensionWorker.evaluate(async payload => openBlbMultiVerseRefs(payload, true), refs);
}

async function getTrackedMultiVerseTabs(extensionWorker) {
  return extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.blueletterbible.org/tools/MultiVerse.cfm*',
        'https://www.blueletterbible.org/search/search.cfm?*blbSuiteMultiVerse=1*'
      ]
    });
    const data = await chrome.storage.local.get({ blbSuiteMultiVerseTabSets: {} });
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    return tabs
      .filter(tab => tracked[String(tab.id)]?.key)
      .map(tab => ({ id: tab.id, key: tracked[String(tab.id)].key }));
  });
}

test('MultiVerse reuses both 200-verse batches when the same selection is repeated or reordered', async ({ context, extensionWorker }) => {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
  }));

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

  const trackedTabs = await getTrackedMultiVerseTabs(extensionWorker);
  expect(new Set(trackedTabs.map(tab => tab.id))).toEqual(new Set(first.tabIds));
  expect(new Set(trackedTabs.map(tab => tab.key)).size).toBe(2);
});

test('case-sensitive gods search opens and reuses both batches', async ({ context, extensionWorker }) => {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
  }));

  const first = await extensionWorker.evaluate(async () => {
    const handled = await handleCaseSensitiveBCommand('gods', 'newForegroundTab');
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.blueletterbible.org/tools/MultiVerse.cfm*',
        'https://www.blueletterbible.org/search/search.cfm?*blbSuiteMultiVerse=1*'
      ]
    });
    const data = await chrome.storage.local.get({
      blbSuiteMultiVerseTabSets:{},
      blbSuitePendingMultiVerseRefsByTab:{}
    });
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    const pending = data.blbSuitePendingMultiVerseRefsByTab || {};
    return {
      handled,
      tabs: tabs.filter(tab => tracked[String(tab.id)]?.key)
        .map(tab => ({
          id:tab.id,
          key:tracked[String(tab.id)].key,
          verseCount:expandMultiVerseRefsToVerses(pending[String(tab.id)] || []).length
        }))
    };
  });
  expect(first.handled).toBe(true);
  expect(first.tabs).toHaveLength(2);
  expect(first.tabs[0].id).not.toBe(first.tabs[1].id);
  expect(new Set(first.tabs.map(tab => tab.key)).size).toBe(2);
  expect(first.tabs.map(tab => tab.verseCount).sort((a,b) => b-a)).toEqual([200,14]);

  const repeated = await extensionWorker.evaluate(async () => {
    await handleCaseSensitiveBCommand('gods', 'newForegroundTab');
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.blueletterbible.org/tools/MultiVerse.cfm*',
        'https://www.blueletterbible.org/search/search.cfm?*blbSuiteMultiVerse=1*'
      ]
    });
    const data = await chrome.storage.local.get({
      blbSuiteMultiVerseTabSets:{},
      blbSuitePendingMultiVerseRefsByTab:{}
    });
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    const pending = data.blbSuitePendingMultiVerseRefsByTab || {};
    return tabs.filter(tab => tracked[String(tab.id)]?.key)
      .map(tab => ({
        id:tab.id,
        key:tracked[String(tab.id)].key,
        verseCount:expandMultiVerseRefsToVerses(pending[String(tab.id)] || []).length
      }));
  });
  expect(repeated.map(tab => tab.id).sort()).toEqual(first.tabs.map(tab => tab.id).sort());
  expect(repeated.map(tab => tab.verseCount).sort((a,b) => b-a)).toEqual([200,14]);
});

test('case-sensitive search reuses the originating tab and leaves no blank orphan', async ({ context, extensionWorker }) => {
  await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
  }));

  const result = await extensionWorker.evaluate(async () => {
    const origin = await chrome.tabs.create({url:'about:blank', active:true});
    const handled = await handleCaseSensitiveBCommand('gods', 'currentTab');
    await new Promise(resolve => setTimeout(resolve, 100));
    const allTabs = await chrome.tabs.query({});
    const data = await chrome.storage.local.get({blbSuiteMultiVerseTabSets:{}, blbSuitePendingMultiVerseRefsByTab:{}});
    const tracked = data.blbSuiteMultiVerseTabSets || {};
    const pending = data.blbSuitePendingMultiVerseRefsByTab || {};
    return {
      handled,
      originId:origin.id,
      originUrl:(await chrome.tabs.get(origin.id)).url,
      blankTabs:allTabs.filter(tab => /^about:blank(?:[#?].*)?$/i.test(String(tab.url || ''))).map(tab => tab.id),
      tracked:allTabs.filter(tab => tracked[String(tab.id)]?.key).map(tab => ({
        id:tab.id,
        key:tracked[String(tab.id)].key,
        verseCount:expandMultiVerseRefsToVerses(pending[String(tab.id)] || []).length
      }))
    };
  });
  expect(result.handled).toBe(true);
  expect(result.originUrl).toContain('blueletterbible.org/tools/MultiVerse.cfm');
  expect(result.blankTabs).not.toContain(result.originId);
  expect(result.tracked.map(tab => tab.id)).toContain(result.originId);
  expect(result.tracked.map(tab => tab.verseCount).sort((a,b) => b-a)).toEqual([200,14]);
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
      lordsTitle: search("Lord's"),
      lordsLower: search("lord's"),
      childrensLower: search("children's"),
      childrensTitle: search("Children's"),
      childrensUpper: search("CHILDREN'S")
    };
  });

  expect(result.lordsUpper).toEqual([1]);
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
