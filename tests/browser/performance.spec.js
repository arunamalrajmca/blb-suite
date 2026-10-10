const { test, expect } = require('./fixtures');
const fs = require('fs');

async function selectReference(page, id) {
  await page.evaluate((elementId) => {
    const el = document.createElement('p');
    el.id = elementId;
    el.textContent = 'John 3:16';
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, id);

  // The content script enables page-selection monitoring asynchronously after
  // reading extension storage. If the synthetic mouseup fires before that
  // initialization completes, the selection remains valid but the extension
  // never receives the event and the button stays hidden. Wait for the control
  // to be mounted, then replay the user-level selection event.
  const button = page.locator('#blb-suite-page-selection-button');
  await expect(button).toBeAttached({ timeout: 10000 });
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  });
  await expect(button).toBeVisible({ timeout: 10000 });
}

async function getBlbTabs(extensionWorker) {
  return extensionWorker.evaluate(async () => {
    // chrome.tabs.query({url}) matches the committed URL only. A newly
    // created BLB tab can temporarily have only pendingUrl, so query all
    // tabs and filter against both URL fields.
    const tabs = await chrome.tabs.query({});
    return tabs
      .map(tab => ({
        id: tab.id,
        url: tab.url || '',
        pendingUrl: tab.pendingUrl || '',
        // During navigation Chrome can expose a non-BLB committed URL while
        // pendingUrl already contains the BLB destination. Prefer a BLB URL
        // from either field so the benchmark does not mistake an in-flight
        // tab for a missing handoff.
        effectiveUrl: /blueletterbible\.org\//i.test(tab.url || '')
          ? (tab.url || '')
          : (tab.pendingUrl || tab.url || ''),
        active: !!tab.active
      }))
      .filter(tab => /^(?:https?:\/\/)?(?:www\.)?blueletterbible\.org\//i.test(tab.effectiveUrl));
  });
}

async function closeBlbTabs(extensionWorker) {
  const tabs = await getBlbTabs(extensionWorker);
  const ids = tabs.map(tab => tab.id).filter(id => Number.isInteger(id));
  if (ids.length) await extensionWorker.evaluate(idsToRemove => chrome.tabs.remove(idsToRemove), ids);
  return ids.length;
}

async function waitForBlbTab(extensionWorker, predicate, timeout = 10000) {
  let match = null;
  await expect.poll(
    async () => {
      const tabs = await getBlbTabs(extensionWorker);
      match = tabs.find(predicate) || null;
      return !!match;
    },
    { timeout }
  ).toBeTruthy();
  return match;
}
async function writeSample(scenario, handoffMs, extra = {}) {
  const output = process.env.BLB_PERF_OUTPUT;
  if (!output) throw new Error('BLB_PERF_OUTPUT is required');
  fs.appendFileSync(output, JSON.stringify({ scenario, handoffMs, ...extra }) + '\n');
  const detail = extra.firstTabMs != null || extra.secondTabMs != null
    ? ` firstTab=${extra.firstTabMs}ms secondTab=${extra.secondTabMs}ms`
    : '';
  console.log(`BLB performance sample: ${scenario} ${handoffMs} ms${detail}`);
}

test('Show on BLB performance benchmark', async ({ page, context, extensionStorage, extensionId, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });

  const scenario = process.env.BLB_PERF_SCENARIO || 'fresh';

  if (scenario === 'selection') {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    // Allow asynchronous page-selection monitoring to finish initializing before the first selection.
    await page.waitForTimeout(1000);
    await selectReference(page, 'blb-perf-selection');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });

    // Isolate the selection benchmark from any BLB tab left by the fixture or
    // the previous scenario. The approved baseline may reuse an existing BLB
    // tab, so requiring a newly allocated tab ID is not a valid contract.
    await closeBlbTabs(extensionWorker);

    const started = Date.now();
    await button.click();

    // Observe Chrome's actual tab state through chrome.tabs, using the
    // destination URL as the completion signal. This works for both the
    // current candidate and the approved baseline whether the action creates
    // a tab or reuses/updates one.
    const blb = await waitForBlbTab(
      extensionWorker,
      tab => /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.effectiveUrl)
    );
    expect(blb).toBeTruthy();
    const handoffMs = Date.now() - started;

    expect(new URL(blb.effectiveUrl).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
    await writeSample(scenario, handoffMs);
    return;
  }

  if (scenario === 'fresh' || scenario === 'reuse') {
    let existing = null;
    if (scenario === 'reuse') {
      // Exercise the filtered BLB-tab lookup against unrelated browser tabs.
      for (let i = 0; i < 30; i++) await context.newPage();
      existing = await context.newPage();
      await existing.goto('https://www.blueletterbible.org/kjv/jhn/3/16/', { waitUntil: 'commit', timeout: 15000 });
    }

    const tabsBefore = await getBlbTabs(extensionWorker);
    const targetTabBefore = tabsBefore.find(tab => /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.effectiveUrl));
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const started = Date.now();
    const response = await page.evaluate(async () => chrome.runtime.sendMessage({
      type: 'blbSuiteOpenSelectionText',
      text: 'John 3:16',
      contextualReference: {
        book: 'John',
        chapter: 3,
        from: 16,
        to: 16,
        url: 'https://www.blueletterbible.org/kjv/jhn/3/16/'
      },
      directUrl: 'https://www.blueletterbible.org/kjv/jhn/3/16/',
      tabBehavior: { activeIfNew: true, activateExisting: true }
    }));
    const handoffMs = Date.now() - started;
    expect(response?.ok).toBeTruthy();

    if (scenario === 'fresh') {
      const tabIdsBefore = new Set(tabsBefore.map(tab => tab.id));
      const blb = await waitForBlbTab(
        extensionWorker,
        tab => !tabIdsBefore.has(tab.id) && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.effectiveUrl)
      );
      expect(blb).toBeTruthy();
      expect(new URL(blb.effectiveUrl).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
    } else {
      const reused = await waitForBlbTab(
        extensionWorker,
        tab => targetTabBefore?.id === tab.id && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.effectiveUrl)
      );
      expect(reused).toBeTruthy();
      expect(new URL(reused.effectiveUrl).pathname).toMatch(/^\/kjv\/jhn\/3\/16\/(?:s_\d+)?$/);
    }

    await writeSample(scenario, handoffMs);
    return;
  }

  if (scenario === 'paragraph-classify') {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const started = Date.now();
    const response = await page.evaluate(async () => chrome.runtime.sendMessage({
      type: 'blbSuiteClassifySelection',
      text: 'Romans 6:23 and John 3:16 teach that the free gift is offered through Christ.'
    }));
    const handoffMs = Date.now() - started;
    expect(response?.ok).toBeTruthy();
    expect(response?.valid).toBeTruthy();
    expect(Array.isArray(response?.refs)).toBeTruthy();
    await writeSample(scenario, handoffMs);
    return;
  }

  if (scenario === 'paragraph-two-tab') {
    await extensionStorage.set({ masterEnabled: true, pageSelectionButtonSites: { 'example.com': true } });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    // Wait for asynchronous page-selection monitoring initialization before creating the first selection.
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const el = document.createElement('p');
      el.id = 'blb-perf-paragraph';
      el.textContent =
        'Romans 6:23 and John 3:16 teach that the free gift is offered through Christ.';
      document.body.appendChild(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Wait for page-selection monitoring to mount before replaying mouseup.
    // This prevents a storage-initialization race from leaving the button
    // hidden even though the selection itself is already present.
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeAttached({ timeout: 10000 });
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    });
    await expect(button).toBeVisible({ timeout: 10000 });

    // This scenario measures the two-tab selection handoff itself. Remove
    // unrelated BLB tabs first so the extension's duplicate-tab reuse policy
    // cannot turn a new-tab benchmark into an existing-tab update benchmark.
    await closeBlbTabs(extensionWorker);
    const tabsBefore = await getBlbTabs(extensionWorker);
    const started = Date.now();
    await button.click();

    // Observe the actual Chrome tabs created by the extension service worker.
    // Do not rely on Playwright context.pages(): chrome.tabs.create() can
    // create tabs before Playwright exposes corresponding Page objects.
    const tabIdsBefore = new Set(tabsBefore.map(tab => tab.id));
    const getOpened = () => getBlbTabs(extensionWorker).then(tabs =>
      tabs.filter(tab => !tabIdsBefore.has(tab.id))
    );
    const isCriteria = tab => /blueletterbible\.org\/search\/search\.cfm\?Criteria=/i.test(tab.effectiveUrl);
    const isMultiVerse = tab => /blueletterbible\.org\/(?:tools\/MultiVerse\.cfm|search\/search\.cfm\?.*blbSuiteMultiVerse=1)/i.test(tab.effectiveUrl);

    await expect.poll(
      async () => (await getOpened()).some(isMultiVerse),
      { timeout: 15000 }
    ).toBeTruthy();
    const firstTabMs = Date.now() - started;

    await expect.poll(
      async () => (await getOpened()).some(isCriteria),
      { timeout: 15000 }
    ).toBeTruthy();
    const secondTabMs = Date.now() - started;

    const opened = await getOpened();
    const multiVerseTab = opened.find(isMultiVerse);
    const criteriaTab = opened.find(isCriteria);
    expect(multiVerseTab).toBeTruthy();
    expect(criteriaTab).toBeTruthy();

    // URL correctness is part of the populated-state check.
    expect(new URL(criteriaTab.effectiveUrl).searchParams.get('Criteria')).toBeTruthy();
    expect(multiVerseTab.effectiveUrl).toMatch(/blueletterbible\.org\/(?:tools\/MultiVerse\.cfm|search\/search\.cfm)/i);

    const handoffMs = Date.now() - started;
    await writeSample(scenario, handoffMs, { firstTabMs, secondTabMs });
    return;
  }

  throw new Error(`Unknown performance scenario: ${scenario}`);
});