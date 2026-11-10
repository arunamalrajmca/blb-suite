const { test, expect } = require('./fixtures');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function summarize(samples, iterations) {
  const perOperation = samples.map(sample => sample.durationMs / iterations);
  return {
    samples: samples.length,
    iterationsPerSample: iterations,
    medianMsPerOperation: Number(median(perOperation).toFixed(5)),
    p90MsPerOperation: Number(percentile(perOperation, 0.9).toFixed(5)),
    medianBatchMs: Number(median(samples.map(sample => sample.durationMs)).toFixed(3))
  };
}

test('selection pipeline phase benchmark: parser, live DOM context, and KJV corpus access', async ({
  page, extensionStorage, extensionWorker
}) => {
  const parserInput = [
    'John 3:16',
    'Romans 8:28-30',
    '1 Corinthians 13:4, 7, 8',
    'Galatians 1:8,9; Revelation 14:6,7',
    'Psalm 119:105',
    '2 Timothy 2:15',
    'Philemon 1:6'
  ];
  const parser = await extensionWorker.evaluate((inputs) => {
    const expected = inputs.map(input => resolveBibleReferenceText(input).length);
    const iterations = 500;
    const samples = [];
    let checksum = 0;
    for (let sample = 0; sample < 9; sample++) {
      for (let warm = 0; warm < 30; warm++) {
        resolveBibleReferenceText(inputs[warm % inputs.length]);
      }
      const started = performance.now();
      for (let i = 0; i < iterations; i++) {
        const refs = resolveBibleReferenceText(inputs[i % inputs.length]);
        checksum += refs.length;
      }
      samples.push({ durationMs: performance.now() - started });
    }
    return { expected, checksum, samples, iterations };
  }, parserInput);

  expect(parser.expected.every(count => count > 0)).toBe(true);
  expect(parser.checksum).toBeGreaterThan(0);

  await extensionStorage.set({
    masterEnabled: true,
    pageSelectionButtonSites: { 'example.com': true },
    doubleClickBlbSites: { 'example.com': true }
  });
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#blb-suite-page-selection-button')).toBeAttached({ timeout: 10000 });
  await page.evaluate(() => {
    const paragraph = document.createElement('p');
    paragraph.id = 'blb-selection-phase-context-fixture';
    paragraph.innerHTML = '<span id="blb-phase-book">John</span><span> 3:16</span>';
    document.body.appendChild(paragraph);
    const book = document.getElementById('blb-phase-book').firstChild;
    const range = document.createRange();
    range.setStart(book, 0);
    range.setEnd(book, book.textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const domContext = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
    const tab = tabs[0];
    if (!tab?.id) throw new Error('Expected the example.com benchmark tab');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => {
        if (typeof getContextualBibleReference !== 'function') {
          throw new Error('The production live DOM contextual resolver is unavailable');
        }
        const expected = getContextualBibleReference('John');
        const iterations = 200;
        const samples = [];
        let checksum = 0;
        for (let sample = 0; sample < 9; sample++) {
          for (let warm = 0; warm < 10; warm++) getContextualBibleReference('John');
          const started = performance.now();
          for (let i = 0; i < iterations; i++) {
            const result = getContextualBibleReference('John');
            if (result?.url) checksum++;
          }
          samples.push({ durationMs: performance.now() - started });
        }
        return {
          expected: expected ? {
            book: expected.book?.name || expected.book || '',
            chapter: expected.chapter,
            from: expected.from,
            to: expected.to,
            url: expected.url || ''
          } : null,
          checksum,
          samples,
          iterations
        };
      }
    });
    return results[0]?.result;
  });

  expect(domContext?.expected?.url).toContain('/kjv/jhn/3/16/');
  expect(domContext.checksum).toBeGreaterThan(0);

  const corpus = await extensionWorker.evaluate(async () => {
    const initial = {
      versesLoaded: Array.isArray(self.KJV_CORPUS_VERSES),
      wordIndexLoaded: !!self.KJV_CORPUS_WORD_VERSE_INDEX,
      phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX
    };
    const time = async operation => {
      const started = performance.now();
      await operation();
      return performance.now() - started;
    };
    const verseAndWordIndexColdMs = await time(() => ensureKjvVerseCorpusLoaded());
    const verseAndWordIndexWarmSamples = [];
    for (let i = 0; i < 9; i++) {
      verseAndWordIndexWarmSamples.push(await time(() => ensureKjvVerseCorpusLoaded()));
    }
    const phraseIndexColdMs = await time(() => ensureKjvPhraseIndexLoaded());
    const phraseIndexWarmSamples = [];
    for (let i = 0; i < 9; i++) {
      phraseIndexWarmSamples.push(await time(() => ensureKjvPhraseIndexLoaded()));
    }
    return {
      initial,
      verseCount: self.KJV_CORPUS_VERSES?.length || 0,
      wordIndexSize: Object.keys(self.KJV_CORPUS_WORD_VERSE_INDEX || {}).length,
      phraseIndexSize: Object.keys(KJV_CORPUS_PHRASE_INDEX || {}).length,
      verseAndWordIndexColdMs,
      verseAndWordIndexWarmSamples,
      phraseIndexColdMs,
      phraseIndexWarmSamples
    };
  });

  expect(corpus.verseCount).toBe(31102);
  expect(corpus.wordIndexSize).toBeGreaterThan(0);
  expect(corpus.phraseIndexSize).toBeGreaterThan(0);

  const report = {
    benchmark: 'selection-pipeline-phases',
    note: 'Diagnostic timings only; no production instrumentation or behavior changes.',
    parser: {
      inputCount: parserInput.length,
      checksum: parser.checksum,
      ...summarize(parser.samples, parser.iterations)
    },
    liveDomContext: {
      expected: domContext.expected,
      checksum: domContext.checksum,
      ...summarize(domContext.samples, domContext.iterations)
    },
    corpus: {
      initial: corpus.initial,
      verseCount: corpus.verseCount,
      wordIndexSize: corpus.wordIndexSize,
      phraseIndexSize: corpus.phraseIndexSize,
      verseAndWordIndexColdMs: Number(corpus.verseAndWordIndexColdMs.toFixed(3)),
      verseAndWordIndexWarmMedianMs: Number(median(corpus.verseAndWordIndexWarmSamples).toFixed(3)),
      phraseIndexColdMs: Number(corpus.phraseIndexColdMs.toFixed(3)),
      phraseIndexWarmMedianMs: Number(median(corpus.phraseIndexWarmSamples).toFixed(3))
    }
  };
  console.log('BLB_SELECTION_PHASE_BENCHMARK ' + JSON.stringify(report));
});
