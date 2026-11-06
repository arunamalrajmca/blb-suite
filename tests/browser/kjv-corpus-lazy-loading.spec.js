const { test, expect } = require('./fixtures');

test.describe('On-demand normalized KJV corpus loading', () => {
  test('ordinary startup and reference-only classification do not load corpus data', async ({ extensionWorker }) => {
    const state = await extensionWorker.evaluate(async () => {
      const before = {
        verses: typeof KJV_CORPUS_VERSES !== 'undefined',
        wordVerseIndex: typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined'
      };
      const reference = await classifySelectionForBlb('John 3:16');
      const word = await classifySelectionForBlb('grace');
      return {
        before,
        referenceType: reference.type,
        wordType: word.type,
        after: {
          verses: typeof KJV_CORPUS_VERSES !== 'undefined',
          wordVerseIndex: typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined'
        }
      };
    });

    expect(state.before).toEqual({ verses: false, wordVerseIndex: false });
    expect(state.referenceType).toBe('REFERENCE');
    expect(state.wordType).toBe('KJV_WORD');
    expect(state.after).toEqual({ verses: false, wordVerseIndex: false });
  });

  test('first corpus-dependent classification loads both datasets and preserves exact verse matching', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const decision = await classifySelectionForBlb('For God so loved the world');
      return {
        decisionType: decision.type,
        versesLoaded: Array.isArray(KJV_CORPUS_VERSES),
        verseCount: KJV_CORPUS_VERSES?.length,
        indexLoaded: !!KJV_CORPUS_WORD_VERSE_INDEX
          && typeof KJV_CORPUS_WORD_VERSE_INDEX === 'object',
        exactMatch: findSingleKjvPhraseMatch('For God so loved the world')
      };
    });

    expect(result.versesLoaded).toBe(true);
    expect(result.verseCount).toBe(31102);
    expect(result.indexLoaded).toBe(true);
    expect(result.exactMatch).toEqual([43, 3, 16]);
    expect(['KJV_PHRASE', 'KJV_REFERENCE_RANGE']).toContain(result.decisionType);
  });

  test('concurrent loads are deduplicated and a failed load can be retried', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const originalFetch = self.fetch;
      let requests = 0;
      let injectedFailure = false;
      self.fetch = async (...args) => {
        requests++;
        if (!injectedFailure) {
          injectedFailure = true;
          return { ok: false, status: 503 };
        }
        return originalFetch(...args);
      };
      let firstAttemptFailed = false;
      try {
        await ensureKjvVerseCorpusLoaded();
      } catch (_) {
        firstAttemptFailed = true;
      }
      await Promise.all([
        ensureKjvVerseCorpusLoaded(),
        ensureKjvVerseCorpusLoaded(),
        ensureKjvVerseCorpusLoaded()
      ]);
      self.fetch = originalFetch;
      return {
        firstAttemptFailed,
        requests,
        versesLoaded: Array.isArray(KJV_CORPUS_VERSES),
        indexLoaded: !!KJV_CORPUS_WORD_VERSE_INDEX
      };
    });

    expect(result.firstAttemptFailed).toBe(true);
    expect(result.requests).toBe(4);
    expect(result.versesLoaded).toBe(true);
    expect(result.indexLoaded).toBe(true);
  });
});
