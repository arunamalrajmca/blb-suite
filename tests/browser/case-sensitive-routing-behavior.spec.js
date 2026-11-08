const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const wordsSource = fs.readFileSync(path.join(root, 'extension/kjv-case-sensitive-words.js'), 'utf8');
const routingSource = fs.readFileSync(path.join(root, 'extension/case-sensitive-routing.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(root, 'extension/case-sensitive-search-core.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');

function loadRouting() {
  const context = {};
  context.self = context;
  vm.runInNewContext(wordsSource + String.fromCharCode(10) + 'this.KJV_CASE_SENSITIVE_WORDS = KJV_CASE_SENSITIVE_WORDS;', context, { filename: 'kjv-case-sensitive-words.js' });
  vm.runInNewContext(routingSource, context, { filename: 'case-sensitive-routing.js' });
  return context;
}

test.describe('KJV case-sensitive word-set and routing behavior', () => {
  test('loads the generated word set and preserves lowercase identities', () => {
    const context = loadRouting();
    const words = context.KJV_CASE_SENSITIVE_WORDS;
    expect(words).toBeTruthy();
    expect(typeof words.size).toBe('number');
    expect(words.size).toBeGreaterThan(900);
    expect(words.has('lord')).toBe(true);
    expect(words.has('jesus')).toBe(true);
    expect(words.has('faith')).toBe(false);
    for (const word of words) {
      expect(word).toBe(word.toLowerCase());
      expect(word.trim()).toBe(word);
    }
  });

  test('routes queries containing a generated case-sensitive word and leaves ordinary words alone', () => {
    const context = loadRouting();
    expect(context.shouldUseCaseSensitiveRouting('LORD')).toBe(true);
    expect(context.shouldUseCaseSensitiveRouting('Jesus')).toBe(true);
    expect(context.shouldUseCaseSensitiveRouting('grace and LORD')).toBe(true);
    expect(context.shouldUseCaseSensitiveRouting('faith')).toBe(false);
    expect(context.shouldUseCaseSensitiveRouting('unlistedword')).toBe(false);
    expect(context.shouldUseCaseSensitiveRouting('   ')).toBe(false);
  });

  test('distinguishes scrambled casing from normal title case and valid LORD possessives', () => {
    const context = loadRouting();
    expect(context.hasScrambledCase('jEsUs')).toBe(true);
    expect(context.hasScrambledCase('loRd')).toBe(true);
    expect(context.hasScrambledCase('Jesus')).toBe(false);
    expect(context.hasScrambledCase('JESUS')).toBe(false);
    expect(context.hasScrambledCase('lord')).toBe(false);
    expect(context.hasScrambledCase("LORD's")).toBe(false);
    expect(context.hasScrambledCase("Lord's")).toBe(false);
  });

  test('parses quoted cs searches without losing the requested capitalization', () => {
    const context = { self: {} };
    vm.runInNewContext(coreSource, context, { filename: 'case-sensitive-search-core.js' });
    const core = context.self.BLBCaseSensitiveCore;
    const parsed = core.parseCaseSensitiveQuery('cs "LORD and Jesus"');
    expect(parsed).toEqual({
      query: 'LORD and Jesus',
      rawQuery: '"LORD and Jesus"',
      words: ['LORD', 'and', 'Jesus']
    });
    expect(core.parseCaseSensitiveQuery('faith and hope')).toBe(null);
  });

  test('background loads the generated routing set on demand before using it', () => {
    const loaderIndex = backgroundSource.indexOf('async function ensureKjvCaseSensitiveWordsLoaded');
    const useIndex = backgroundSource.indexOf('await ensureKjvCaseSensitiveWordsLoaded();');
    const routeIndex = backgroundSource.indexOf('shouldUseCaseSensitiveRouting(parsed.query)');
    expect(loaderIndex).toBeGreaterThan(-1);
    expect(useIndex).toBeGreaterThan(loaderIndex);
    expect(routeIndex).toBeGreaterThan(useIndex);
    expect(/BLB_BACKGROUND_STARTUP_IMPORTS[\\s\\S]*?[\"']case-sensitive-routing\\.js[\"']/.test(backgroundSource)).toBe(true);
  });
});

test('MV3 worker routes a real exact-case KJV word to its single matching verse', async ({ extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  const beforeIds = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );

  // Verify ordinary worker startup omits the original-case corpus, then exercise
  // the real omnibox entry point before deriving the exact expected destination.
  const runtimeRouting = await extensionWorker.evaluate(() => ({
    caseSensitiveWordsLoaded: typeof KJV_CASE_SENSITIVE_WORDS !== 'undefined',
    originalCaseLoaded: typeof KJV_CORPUS_ORIGINAL_CASE !== 'undefined',
    caseVerseIndexLoaded: typeof KJV_CORPUS_CASE_VERSE_INDEX !== 'undefined'
  }));
  expect(runtimeRouting.caseSensitiveWordsLoaded,
    'the case-sensitive routing set must stay unloaded during ordinary worker startup').toBe(false);
  expect(runtimeRouting.originalCaseLoaded,
    'the multi-megabyte original-case corpus must stay unloaded during ordinary worker startup').toBe(false);
  expect(runtimeRouting.caseVerseIndexLoaded,
    'the case-sensitive verse index must stay unloaded during ordinary worker startup').toBe(false);

  let expected = null;
  try {
    // Exercise the real command first; it must load the corpus only when the
    // query actually takes the exact-case local-search path.
    await extensionWorker.evaluate(async () => {
      await handleOmniboxCommand('cs Fathers', 'newBackgroundTab');
    });
    expected = await extensionWorker.evaluate(() => {
    const matches = BLBCaseSensitiveCore.searchCaseSensitiveCorpus(
      'Fathers',
      KJV_CORPUS_ORIGINAL_CASE,
      KJV_CORPUS_CASE_VERSE_INDEX
    );
    if (matches.length !== 1) return { count: matches.length };
    const entry = matches[0];
    const book = BOOKS.find(item => Number(item.bookNumber) === Number(entry[0]));
    return {
      count: matches.length,
      text: entry[3],
      url: book
        ? 'https://www.blueletterbible.org/kjv/' + book.urlKey + '/' + entry[1] + '/' + entry[2] + '/'
        : null
    };
    });
    expect(expected.count, 'the exact-case fixture term should resolve to one KJV verse').toBe(1);
    expect(expected.text.split(/[^A-Za-z]+/).includes('Fathers'),
      'the selected original-case verse must contain the requested capitalization').toBe(true);
    expect(expected.url).toMatch(/^https:\/\/www\.blueletterbible\.org\/kjv\//);
    const loadedAfterSearch = await extensionWorker.evaluate(() => ({
      caseSensitiveWords: typeof KJV_CASE_SENSITIVE_WORDS !== 'undefined',
      originalCaseCorpus: typeof KJV_CORPUS_ORIGINAL_CASE !== 'undefined',
      caseVerseIndex: typeof KJV_CORPUS_CASE_VERSE_INDEX !== 'undefined'
    }));
    expect(loadedAfterSearch.caseSensitiveWords,
      'the exact-case routing set must load before the local routing decision').toBe(true);
    expect(loadedAfterSearch.originalCaseCorpus,
      'an actual exact-case search must load the original-case corpus before matching').toBe(true);
    expect(loadedAfterSearch.caseVerseIndex,
      'an actual exact-case search must load its verse index before matching').toBe(true);

    await expect.poll(async () => extensionWorker.evaluate(({ beforeIds, expectedUrl }) =>
      chrome.tabs.query({}).then(tabs => tabs.some(tab =>
        !beforeIds.includes(tab.id) &&
        String(tab.url || tab.pendingUrl || '') === expectedUrl
      ))
    , { beforeIds, expectedUrl: expected.url }), {
      timeout: 10000,
      intervals: [100, 200, 300]
    }).toBe(true);
  } finally {
    if (expected?.url) {
      await extensionWorker.evaluate(({ beforeIds, expectedUrl }) =>
        chrome.tabs.query({}).then(async tabs => {
          for (const tab of tabs) {
            if (!beforeIds.includes(tab.id) &&
                String(tab.url || tab.pendingUrl || '') === expectedUrl &&
                Number.isInteger(tab.id)) {
              await chrome.tabs.remove(tab.id).catch(() => {});
            }
          }
        })
      , { beforeIds, expectedUrl: expected.url });
    }
  }
});

test('MV3 worker keeps the large exact-case corpus unloaded for a native-fallback cs query', async ({ extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  const beforeIds = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );
  try {
    await extensionWorker.evaluate(async () => {
      await handleOmniboxCommand('cs faith', 'newBackgroundTab');
    });
    const loaded = await extensionWorker.evaluate(() => ({
      caseSensitiveWords: typeof KJV_CASE_SENSITIVE_WORDS !== 'undefined',
      originalCaseCorpus: typeof KJV_CORPUS_ORIGINAL_CASE !== 'undefined',
      caseVerseIndex: typeof KJV_CORPUS_CASE_VERSE_INDEX !== 'undefined'
    }));
    expect(loaded.caseSensitiveWords,
      'the compact routing set is needed to decide whether local exact-case search applies').toBe(true);
    expect(loaded.originalCaseCorpus,
      'a query outside the local case-sensitive routing set must not load the large corpus').toBe(false);
    expect(loaded.caseVerseIndex,
      'a native-fallback query must not load the local exact-case verse index').toBe(false);
  } finally {
    await extensionWorker.evaluate(beforeIds => chrome.tabs.query({}).then(async tabs => {
      for (const tab of tabs) {
        if (!beforeIds.includes(tab.id) && Number.isInteger(tab.id)) {
          await chrome.tabs.remove(tab.id).catch(() => {});
        }
      }
    }), beforeIds);
  }
});
