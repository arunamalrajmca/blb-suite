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

  test('background loads the generated set before the routing helper', () => {
    const wordsIndex = backgroundSource.indexOf("'kjv-case-sensitive-words.js'");
    const routingIndex = backgroundSource.indexOf("'case-sensitive-routing.js'");
    expect(wordsIndex).toBeGreaterThan(-1);
    expect(routingIndex).toBeGreaterThan(wordsIndex);
    expect(backgroundSource.includes('shouldUseCaseSensitiveRouting')).toBe(true);
  });
});

test('MV3 worker routes a real exact-case KJV word to its single matching verse', async ({ extensionStorage, extensionWorker }) => {
  await extensionStorage.set({ masterEnabled: true });
  const beforeIds = await extensionWorker.evaluate(() =>
    chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))
  );

  // Derive the expected destination from the packaged original-case corpus,
  // then exercise the real omnibox entry point in the running extension worker.
  const expected = await extensionWorker.evaluate(() => {
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

  try {
    await extensionWorker.evaluate(async () => {
      await handleOmniboxCommand('cs Fathers', 'newBackgroundTab');
    });

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
});
