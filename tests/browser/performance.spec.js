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
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, id);
}

async function getBlbTabs(extensionWorker) {
  return extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({url:'https://www.blueletterbible.org/*'});
    return tabs.map(tab => ({id:tab.id, url:tab.url || tab.pendingUrl || '', active:!!tab.active}));
  });
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
    await selectReference(page, 'blb-perf-selection');
    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });

    // The extension may intentionally reuse an existing BLB tab. Remove
    // unrelated BLB tabs so this two-tab benchmark observes the actual
    // MultiVerse + Criteria handoff rather than an update to an old tab.
    await closeBlbTabs(extensionWorker);
    const tabsBefore = await getBlbTabs(extensionWorker);
    const started = Date.now();
    await button.click();
    const tabIdsBefore = new Set(tabsBefore.map(tab => tab.id));
    const blb = await waitForBlbTab(extensionWorker, tab => !tabIdsBefore.has(tab.id) && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.url));
    expect(blb).toBeTruthy();
    const handoffMs = Date.now() - started;

    expect(new URL(blb.url).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
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
    const targetTabBefore = tabsBefore.find(tab => /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.url));
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
        tab => !tabIdsBefore.has(tab.id) && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.url)
      );
      expect(blb).toBeTruthy();
      expect(new URL(blb.url).pathname).toMatch(/^\/kjv\/jhn\/3\/16\//);
    } else {
      const reused = await waitForBlbTab(
        extensionWorker,
        tab => targetTabBefore?.id === tab.id && /blueletterbible\.org\/kjv\/jhn\/3\/16\//i.test(tab.url)
      );
      expect(reused).toBeTruthy();
      expect(new URL(reused.url).pathname).toMatch(/^\/kjv\/jhn\/3\/16\/(?:s_\d+)?$/);
    }

    await writeSample(scenario, handoffMs);
    return;
  }

  if (scenario === 'range-resolver') {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const cases = [
      {
        text: 'For God so loved the world, that he gave his only begotten Son',
        book: 'John', bookNumber: 43, chapter: 3, from: 16, to: 16
      },
      {
        text: 'For the wages of sin is death; but the gift of God is eternal life through Jesus Christ our Lord',
        book: 'Romans', bookNumber: 45, chapter: 6, from: 23, to: 23
      },
      {
        text: 'Blessed are the poor in spirit: for theirs is the kingdom of heaven',
        book: 'Matthew', bookNumber: 40, chapter: 5, from: 3, to: 3
      },
      {
        text: 'But as for you, ye thought evil against me; but God meant it unto good',
        book: 'Genesis', bookNumber: 1, chapter: 50, from: 20, to: 20
      }
    ];
    const samples = [];
    for (const item of cases) {
      const started = Date.now();
      const result = await extensionWorker.evaluate(({text, book, bookNumber, chapter, verse, variant}) => {
        if (variant === 'candidate') {
          return {result: findKjvVerseRangeForSelection(text)};
        }
        const words = normalizeKjvPassageWords(text);
        const corpus = getKjvRangeVerseCache();
        const corpusIndex = corpus.findIndex(v => v.bookNumber === bookNumber && v.chapter === chapter && v.verse === verse);
        const verseWords = corpusIndex >= 0 ? corpus[corpusIndex].words : [];
        const seedLength = KJV_PASSAGE_MIN_WORDS;
        const seedPositions = new Map();
        for (let i = 0; i <= words.length - seedLength; i++) {
          const seed = words.slice(i, i + seedLength).join(' ');
          const positions = seedPositions.get(seed) || [];
          if (positions.length < 4) positions.push(i);
          seedPositions.set(seed, positions);
        }
        const match = corpusIndex >= 0 ? longestCommonKjvPassage(words, verseWords, seedPositions) : null;
        return {
          result: findKjvVerseRangeForSelection(text),
          words: words.length,
          corpusIndex,
          verseWords: verseWords.length,
          match,
          meaningful: match ? isMeaningfulShortKjvPassage(match.text, match.length) : false
        };
      }, {text:item.text, book:item.book, bookNumber:item.bookNumber, chapter:item.chapter, verse:item.from, variant:process.env.BLB_PERF_VARIANT});
      samples.push(Date.now() - started);
      console.log('KJV range diagnostic', JSON.stringify(result));
      console.log('KJV range diagnostic case', JSON.stringify({
        variant: process.env.BLB_PERF_VARIANT || 'unknown',
        expected: {book:item.book, chapter:item.chapter, from:item.from, to:item.to},
        actual: result.result || null,
        corpusIndex: result.corpusIndex,
        verseWords: result.verseWords,
        match: result.match,
        meaningful: result.meaningful
      }));
      if (process.env.BLB_PERF_VARIANT === 'candidate') {
        expect(String(result.result?.book || '').toLowerCase()).toBe(item.book.toLowerCase());
        expect(result.result?.chapter).toBe(item.chapter);
        expect(result.result?.from).toBe(item.from);
        expect(result.result?.to).toBe(item.to);
      }
    }
    const handoffMs = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
    await writeSample(scenario, handoffMs, { caseCount: cases.length, caseMs: samples });
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
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const button = page.locator('#blb-suite-page-selection-button');
    await expect(button).toBeVisible({ timeout: 10000 });

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
    const isCriteria = tab => /blueletterbible\.org\/search\/search\.cfm\?Criteria=/i.test(tab.url);
    const isMultiVerse = tab => /blueletterbible\.org\/(?:tools\/MultiVerse\.cfm|search\/search\.cfm\?.*blbSuiteMultiVerse=1)/i.test(tab.url);

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
    expect(new URL(criteriaTab.url).searchParams.get('Criteria')).toBeTruthy();
    expect(multiVerseTab.url).toMatch(/blueletterbible\.org\/(?:tools\/MultiVerse\.cfm|search\/search\.cfm)/i);

    const handoffMs = Date.now() - started;
    await writeSample(scenario, handoffMs, { firstTabMs, secondTabMs });
    return;
  }

  throw new Error(`Unknown performance scenario: ${scenario}`);
});