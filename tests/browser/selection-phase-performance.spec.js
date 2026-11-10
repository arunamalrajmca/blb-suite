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
  const domContext = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
    const tab = tabs[0];
    if (!tab?.id) throw new Error('Expected the example.com benchmark tab');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => {
        if (typeof getSelectionContextPosition !== 'function') {
          throw new Error('The production live DOM selection-context extractor is unavailable');
        }
        const paragraph = document.createElement('p');
        paragraph.id = 'blb-selection-phase-context-fixture';
        paragraph.textContent = 'John 3:16';
        document.body.appendChild(paragraph);
        const textNode = paragraph.firstChild;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 'John'.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__blbSuiteEnableSelectionDiagnostics = true;
        const selectionProbe = {
          text: selection.toString(),
          rangeCount: selection.rangeCount,
          collapsed: selection.isCollapsed,
          startNode: selection.anchorNode?.nodeName || '',
          startOffset: selection.anchorOffset,
          endNode: selection.focusNode?.nodeName || '',
          endOffset: selection.focusOffset,
          directText: textNode.nodeValue
        };
        const expected = getSelectionContextPosition();
        const selectionDiagnostic = window.__blbSuiteSelectionContextDiagnostic || null;
        const iterations = 200;
        const samples = [];
        let checksum = 0;
        for (let sample = 0; sample < 9; sample++) {
          for (let warm = 0; warm < 10; warm++) getSelectionContextPosition();
          const started = performance.now();
          for (let i = 0; i < iterations; i++) {
            const result = getSelectionContextPosition();
            if (result?.text && result.text.slice(result.start, result.end) === 'John') checksum++;
          }
          samples.push({ durationMs: performance.now() - started });
        }
        return JSON.stringify({
          expected: expected ? {
            selected: expected.text.slice(expected.start, expected.end),
            context: expected.text
          } : null,
          selectionProbe,
          selectionDiagnostic,
          checksum,
          samples,
          iterations
        });
      }
    });
    return {
      resultCount: results.length,
      frames: results.map(item => ({ frameId: item.frameId, result: item.result ?? null })),
      tabId: tab.id
    };
  });

  expect(domContext.resultCount, JSON.stringify(domContext)).toBe(1);
  const domMeasurement = domContext.frames[0]?.result ? JSON.parse(domContext.frames[0].result) : null;
  expect(domMeasurement?.expected?.selected, JSON.stringify(domContext)).toBe('John');
  expect(domMeasurement?.expected?.context).toContain('John 3:16');
  expect(domMeasurement.checksum).toBeGreaterThan(0);

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
    domSelectionContext: {
      expected: domMeasurement.expected,
      checksum: domMeasurement.checksum,
      ...summarize(domMeasurement.samples, domMeasurement.iterations)
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
