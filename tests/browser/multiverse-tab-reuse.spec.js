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
