const { test, expect } = require('./fixtures');

const BATCH_A = [
  { bookNumber: 1, chapter: 1, from: 1, to: 1, version: 'kjv' },
  { bookNumber: 1, chapter: 1, from: 3, to: 3, version: 'kjv' }
];

const BATCH_B = [
  { bookNumber: 2, chapter: 1, from: 1, to: 1, version: 'kjv' },
  { bookNumber: 2, chapter: 1, from: 3, to: 3, version: 'kjv' }
];

async function openMultiVerse(extensionWorker, refs) {
  return extensionWorker.evaluate(async (payload) => {
    const response = await chrome.runtime.sendMessage({
      type: 'blbSuiteOpenWebsterMultiVerse',
      refs: payload
    });
    return response;
  }, refs);
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

test.describe('MultiVerse batch tab identity', () => {
  test('reuses both distinct batches when repeated in either order', async ({ context, extensionWorker }) => {
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    }));

    const first = await openMultiVerse(extensionWorker, [...BATCH_A, ...BATCH_B]);
    expect(first?.ok).toBe(true);
    expect(first.batchCount).toBe(1);
    const firstIds = first.tabIds;
    expect(firstIds).toHaveLength(1);

    const repeated = await openMultiVerse(extensionWorker, [...BATCH_A, ...BATCH_B]);
    expect(repeated?.ok).toBe(true);
    expect(repeated.tabIds).toEqual(firstIds);

    // Reversing the reference order must still find each batch by its own
    // canonical verse-set key rather than assuming batch position is identity.
    const reversed = await openMultiVerse(extensionWorker, [...BATCH_B, ...BATCH_A]);
    expect(reversed?.ok).toBe(true);
    expect(reversed.tabIds).toEqual(firstIds);

    const trackedTabs = await getTrackedMultiVerseTabs(extensionWorker);
    expect(new Set(trackedTabs.map(tab => tab.id))).toEqual(new Set(firstIds));
    expect(new Set(trackedTabs.map(tab => tab.key)).size).toBe(1);
  });

  test('keeps separate verse sets in separate tabs and reuses each after order changes', async ({ context, extensionWorker }) => {
    await context.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>MultiVerse test fixture</title></head><body>MultiVerse fixture</body></html>'
    }));

    const a = await openMultiVerse(extensionWorker, BATCH_A);
    const b = await openMultiVerse(extensionWorker, BATCH_B);
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(true);
    expect(a.tabIds).toHaveLength(1);
    expect(b.tabIds).toHaveLength(1);
    expect(a.tabIds[0]).not.toBe(b.tabIds[0]);

    const bThenA = await openMultiVerse(extensionWorker, [...BATCH_B, ...BATCH_A]);
    expect(bThenA?.ok).toBe(true);
    expect(new Set(bThenA.tabIds)).toEqual(new Set([...a.tabIds, ...b.tabIds]));

    const trackedTabs = await getTrackedMultiVerseTabs(extensionWorker);
    expect(new Set(trackedTabs.map(tab => tab.id))).toEqual(new Set([...a.tabIds, ...b.tabIds]));
    expect(new Set(trackedTabs.map(tab => tab.key)).size).toBe(2);
  });
});
