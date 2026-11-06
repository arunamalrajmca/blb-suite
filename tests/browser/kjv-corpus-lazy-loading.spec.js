const { test, expect } = require('./fixtures');
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
        phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX,
        exactMatch: findSingleKjvPhraseMatch('For God so loved the world')?.slice(0, 3)
      };
    });

    expect(result.versesLoaded).toBe(true);
    expect(result.verseCount).toBe(31102);
    expect(result.indexLoaded).toBe(true);
    expect(result.phraseIndexLoaded).toBe(false);
    expect(result.exactMatch).toEqual([43, 3, 16]);
    expect(['KJV_PHRASE', 'KJV_REFERENCE_RANGE']).toContain(result.decisionType);
  });

  test('short exact KJV phrases load corpus and phrase-index data together', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const decision = await classifySelectionForBlb('God is love');
      return {
        decisionType: decision.type,
        versesLoaded: Array.isArray(KJV_CORPUS_VERSES),
        wordIndexLoaded: !!KJV_CORPUS_WORD_VERSE_INDEX,
        phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX
      };
    });

    expect(result.decisionType).toBe('KJV_PASSAGE');
    expect(result.versesLoaded).toBe(true);
    expect(result.wordIndexLoaded).toBe(true);
    expect(result.phraseIndexLoaded).toBe(true);
  });

  test('rejected compressed-resource fetches fall back to original packaged JavaScript data', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const originalFetch = self.fetch;
      let gzipRequests = 0;
      let fallbackRequests = 0;
      self.fetch = async (input, ...args) => {
        const url = String(input);
        if (url.endsWith('.json.gz')) {
          gzipRequests++;
          throw new TypeError('Failed to fetch');
        }
        if (/kjv-corpus-(verses|word-verse-index|phrase-index)\.js(?:$|[?#])/.test(url)) {
          fallbackRequests++;
        }
        return originalFetch(input, ...args);
      };
      try {
        await ensureKjvVerseCorpusLoaded();
        await ensureKjvPhraseIndexLoaded();
        return {
          gzipRequests,
          fallbackRequests,
          verseCount: KJV_CORPUS_VERSES?.length,
          wordIndexLoaded: !!KJV_CORPUS_WORD_VERSE_INDEX,
          phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX,
          exactMatch: findSingleKjvPhraseMatch('For God so loved the world')?.slice(0, 3)
        };
      } finally {
        self.fetch = originalFetch;
      }
    });

    expect(result.gzipRequests).toBe(3);
    expect(result.fallbackRequests).toBe(3);
    expect(result.verseCount).toBe(31102);
    expect(result.wordIndexLoaded).toBe(true);
    expect(result.phraseIndexLoaded).toBe(true);
    expect(result.exactMatch).toEqual([43, 3, 16]);
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


test('interleaved 15-pair cold-start and first-corpus-use A/B against current main', async () => {
  // Keep ordinary browser suites fast; only the dedicated performance job
  // supplies BLB_PERF_OUTPUT and runs the paired benchmark.
  test.skip(!process.env.BLB_PERF_OUTPUT, 'runs only in the dedicated performance qualification job');
  test.setTimeout(300000);

  const repoRoot = path.resolve(__dirname, '../..');
  const baselineRef = process.env.GITHUB_BASE_REF || 'main';
  execFileSync('git', ['fetch', '--depth=1', 'origin', baselineRef], { cwd: repoRoot, stdio: 'pipe' });
  const baselineSha = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
    cwd: repoRoot, encoding: 'utf8'
  }).trim();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-corpus-ab-'));
  const baselineRoot = path.join(tempRoot, 'baseline');
  const candidateRoot = path.join(tempRoot, 'candidate');
  fs.mkdirSync(baselineRoot, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'extension'), candidateRoot, { recursive: true });

  // Generate the exact compressed assets used by the production candidate.
  execFileSync(process.execPath, [
    path.resolve(repoRoot, 'scripts/generate-kjv-gzip-assets.cjs'),
    candidateRoot
  ], { cwd: repoRoot, stdio: 'pipe' });

  const archive = execFileSync('git', ['archive', baselineSha, 'extension'], {
    cwd: repoRoot,
    maxBuffer: 100 * 1024 * 1024
  });
  execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { cwd: repoRoot, input: archive });
  const variants = {
    baseline: path.join(baselineRoot, 'extension'),
    candidate: candidateRoot
  };

  const instrument = extensionDir => {
    const backgroundPath = path.join(extensionDir, 'background.js');
    let source = fs.readFileSync(backgroundPath, 'utf8');
    const match = source.match(/^\uFEFF?\s*importScripts\(([^;]+)\);/);
    if (!match) throw new Error('Unable to instrument the service-worker importScripts bootstrap');
    const scripts = [...match[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map(item => item[1]);
    if (!scripts.length) throw new Error('No service-worker imports were found for A/B timing');
    const replacement = 'const __blbProfileBootstrapAt = performance.now();\n'
      + 'const __blbProfilePhases = [];\n'
      + 'for (const __blbScript of ' + JSON.stringify(scripts) + ') {\n'
      + '  const __blbImportStartedAt = performance.now();\n'
      + '  importScripts(__blbScript);\n'
      + "  __blbProfilePhases.push({ phase: 'service-worker-importScript', script: __blbScript, durationMs: performance.now() - __blbImportStartedAt });\n"
      + '}\n'
      + 'globalThis.__BLB_PROFILE_STARTUP__ = { bootstrapAt: __blbProfileBootstrapAt, phases: __blbProfilePhases };\n'
      + 'globalThis.__BLB_PROFILE_LOAD__ = { events: [] };';
    source = source.replace(match[0], replacement);
    const fetchStart = "  const response = await fetch(chrome.runtime.getURL(filename));";
    const fetchEnd = "  const source = await response.text();";
    const extractStart = "  const start = source.indexOf(assignment);";
    const extractEnd = "  const json = source.slice(start + assignment.length, end);";
    const parseLine = "  return JSON.parse(allowTrailingObjectComma ? json.replace(/,(\\s*})$/, '$1') : json);";
    if (!source.includes(fetchStart) || !source.includes(fetchEnd) || !source.includes(parseLine)) {
      throw new Error('Unable to instrument packaged JSON fetch/read/parse phases');
    }
    source = source.replace(fetchStart,
      "  const __blbFetchStarted = performance.now();\n" + fetchStart);
    source = source.replace("  if (!response.ok) {",
      "  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-json-fetch', file: filename, durationMs: performance.now() - __blbFetchStarted });\n  if (!response.ok) {");
    source = source.replace(fetchEnd,
      "  const __blbReadStarted = performance.now();\n" + fetchEnd +
      "\n  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-json-read', file: filename, durationMs: performance.now() - __blbReadStarted });");
    source = source.replace(extractStart,
      "  const __blbExtractStarted = performance.now();\n" + extractStart);
    source = source.replace(extractEnd,
      extractEnd + "\n  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-json-extract', file: filename, durationMs: performance.now() - __blbExtractStarted });");
    source = source.replace(parseLine,
      "  const __blbParseStarted = performance.now();\n" +
      "  const __blbParsed = JSON.parse(allowTrailingObjectComma ? json.replace(/,(\\s*})$/, '$1') : json);\n" +
      "  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-json-parse', file: filename, durationMs: performance.now() - __blbParseStarted });\n" +
      "  return __blbParsed;");
    const gzipStart = source.indexOf('async function fetchPackagedGzipJson(filename) {');
    const gzipEnd = source.indexOf('\\nasync function ensureKjvVerseCorpusLoaded()', gzipStart);
    if (gzipStart >= 0 && gzipEnd > gzipStart) {
      let gzipLoader = source.slice(gzipStart, gzipEnd);
      gzipLoader = gzipLoader.replace(
        "  const response = await fetch(chrome.runtime.getURL(filename));",
        "  const __blbGzipFetchStarted = performance.now();\\n  const response = await fetch(chrome.runtime.getURL(filename));"
      );
      gzipLoader = gzipLoader.replace(
        "  const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));",
        "  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-gzip-fetch', file: filename, durationMs: performance.now() - __blbGzipFetchStarted });\\n"
        + "  const __blbGzipDecodeStarted = performance.now();\\n"
        + "  const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));"
      );
      gzipLoader = gzipLoader.replace(
        "  return new Response(decompressed).json();",
        "  const __blbDecoded = await new Response(decompressed).json();\\n"
        + "  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-gzip-decompress-json', file: filename, durationMs: performance.now() - __blbGzipDecodeStarted });\\n"
        + "  return __blbDecoded;"
      );
      source = source.slice(0, gzipStart) + gzipLoader + source.slice(gzipEnd);
    }
    const fromEntries = "      const wordVerseIndex = Object.fromEntries(wordVerseEntries);";
    source = source.replace(fromEntries,
      "      const __blbIndexBuildStarted = performance.now();\n" + fromEntries +
      "\n      globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'word-verse-index-build', durationMs: performance.now() - __blbIndexBuildStarted });");
    const corpusValidationStart = "      if (!Array.isArray(verseEntries) || verseEntries.length !== 31102) {";
    source = source.replace(corpusValidationStart,
      "      const __blbCorpusValidationStarted = performance.now();\n" + corpusValidationStart);
    const fromEntriesValidation = "      const wordVerseIndex = Object.fromEntries(wordVerseEntries);";
    source = source.replace(fromEntriesValidation,
      "      globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'corpus-data-validation', durationMs: performance.now() - __blbCorpusValidationStarted });\n" + fromEntriesValidation);
    const wordIndexValidationStart = "      if (!wordVerseIndex || typeof wordVerseIndex !== 'object'";
    source = source.replace(wordIndexValidationStart,
      "      const __blbWordIndexValidationStarted = performance.now();\n" + wordIndexValidationStart);
    const corpusAssignment = "      self.KJV_CORPUS_VERSES = verseEntries;";
    source = source.replace(corpusAssignment,
      "      globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'word-index-validation', durationMs: performance.now() - __blbWordIndexValidationStarted });\n" + corpusAssignment);
    const rangeCall = "    const corpusRange = findKjvVerseRangeForSelection(source);";
    source = source.replace(rangeCall,
      "    const __blbRangeStarted = performance.now();\n" + rangeCall +
      "\n    globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'downstream-corpus-classification', durationMs: performance.now() - __blbRangeStarted });");
    fs.writeFileSync(backgroundPath, source);
  };
  instrument(variants.baseline);
  instrument(variants.candidate);

  const measureColdRun = async (extensionDir, variant, repetition) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
        '--disable-extensions-except=' + extensionDir,
        '--load-extension=' + extensionDir,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    try {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
      await worker.evaluate(async () => {
        const deadline = performance.now() + 10000;
        while (!globalThis.__BLB_PROFILE_STARTUP__ && performance.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!globalThis.__BLB_PROFILE_STARTUP__) {
          throw new Error('Service-worker startup instrumentation was not initialized before measurement');
        }
      });
      return await worker.evaluate(async ({ variant, repetition }) => {
        const startup = globalThis.__BLB_PROFILE_STARTUP__;
        if (!startup || !Array.isArray(startup.phases)) {
          throw new Error('Service-worker startup timing instrumentation was not initialized');
        }
        const startupToFirstEvaluationMs = performance.now() - startup.bootstrapAt;
        const importPhases = startup.phases.filter(phase => phase.phase === 'service-worker-importScript');
        const importScriptsMs = importPhases.reduce((sum, phase) => sum + phase.durationMs, 0);
        const corpusLoadedAtStartup = typeof KJV_CORPUS_VERSES !== 'undefined'
          && typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined';

        const referenceStartedAt = performance.now();
        const reference = await classifySelectionForBlb('John 3:16');
        const referenceOnlyMs = performance.now() - referenceStartedAt;

        const wordStartedAt = performance.now();
        const word = await classifySelectionForBlb('grace');
        const singleWordMs = performance.now() - wordStartedAt;
        const corpusStillLoadedAfterFastPaths = typeof KJV_CORPUS_VERSES !== 'undefined'
          && typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined';

        // Start with a short exact phrase on a genuinely cold corpus. This
        // first operation must load both the verse corpus and phrase index.
        const firstPhraseStartedAt = performance.now();
        const phrase = await classifySelectionForBlb('God is love');
        const firstPhraseUseMs = performance.now() - firstPhraseStartedAt;
        const firstUseProfileEvents = [...(globalThis.__BLB_PROFILE_LOAD__?.events || [])];

        // A longer KJV passage is now a warm corpus/phrase-index operation.
        const warmStartedAt = performance.now();
        const passage = await classifySelectionForBlb('For God so loved the world');
        const warmCorpusUseMs = performance.now() - warmStartedAt;
        const phraseUseProfileEvents = [...(globalThis.__BLB_PROFILE_LOAD__?.events || [])];

        return {
          variant,
          repetition,
          startupToFirstEvaluationMs,
          importScriptsMs,
          importedScripts: importPhases.map(phase => ({
            script: phase.script,
            durationMs: phase.durationMs
          })),
          corpusLoadedAtStartup,
          corpusStillLoadedAfterFastPaths,
          corpusLoadedAfterFirstUse: typeof KJV_CORPUS_VERSES !== 'undefined'
            && typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined',
          referenceType: reference.type,
          wordType: word.type,
          passageType: passage.type,
          phraseType: phrase.type,
          phraseQuery: phrase.kjvPassageQuery || phrase.text,
          passageRef: passage.directRef ? {
            book: passage.directRef.book,
            chapter: passage.directRef.chapter,
            from: passage.directRef.from,
            to: passage.directRef.to
          } : null,
          referenceOnlyMs,
          singleWordMs,
          firstCorpusUseMs: firstPhraseUseMs,
          firstUseProfileEvents,
          warmCorpusUseMs,
          firstPhraseUseMs,
          phraseUseProfileEvents
        };
      }, { variant, repetition });
    } finally {
      await context.close();
    }
  };

  const samples = [];
  try {
    for (let repetition = 1; repetition <= 15; repetition++) {
      const order = repetition % 2 === 1
        ? ['baseline', 'candidate']
        : ['candidate', 'baseline'];
      for (const variant of order) {
        const sample = await measureColdRun(variants[variant], variant, repetition);
        samples.push(sample);
        console.log('BLB_CORPUS_AB_SAMPLE ' + JSON.stringify(sample));
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const summarize = variant => {
    const rows = samples.filter(sample => sample.variant === variant);
    return {
      repetitions: rows.length,
      startupToFirstEvaluationMs: median(rows.map(row => row.startupToFirstEvaluationMs)),
      importScriptsMs: median(rows.map(row => row.importScriptsMs)),
      referenceOnlyMs: median(rows.map(row => row.referenceOnlyMs)),
      singleWordMs: median(rows.map(row => row.singleWordMs)),
      firstCorpusUseMs: median(rows.map(row => row.firstCorpusUseMs)),
      warmCorpusUseMs: median(rows.map(row => row.warmCorpusUseMs)),
      firstPhraseUseMs: median(rows.map(row => row.firstPhraseUseMs))
    };
  };
  const summary = {
    baselineSha,
    baseline: summarize('baseline'),
    candidate: summarize('candidate'),
    rawSamples: samples
  };
  const output = JSON.stringify({ scenario: 'kjv-corpus-lazy-loading-ab', ...summary });
  const performanceOutputPath = process.env.BLB_PERF_OUTPUT || path.join(repoRoot, 'blb-corpus-ab-results.json');
  fs.appendFileSync(performanceOutputPath, output + '\n');
  console.log('BLB_CORPUS_AB_OUTPUT ' + performanceOutputPath);
  console.log('BLB_CORPUS_AB_SUMMARY ' + output);

  for (const sample of samples) {
    expect(sample.referenceType).toBe('REFERENCE');
    expect(sample.wordType).toBe('KJV_WORD');
    expect(sample.passageType).toBe('KJV_REFERENCE_RANGE');
    // The lazy-loading experiment must preserve the baseline classification
    // for both variants; only the data-loading timing is allowed to differ.
    expect(sample.phraseType).toBe('KJV_PASSAGE');
    expect(sample.phraseQuery).toBeTruthy();
    expect(sample.passageRef).toEqual({ book: 'john', chapter: 3, from: 16, to: 16 });
    if (sample.variant === 'baseline') {
      expect(sample.corpusLoadedAtStartup).toBe(true);
    } else {
      expect(sample.corpusLoadedAtStartup).toBe(false);
      expect(sample.corpusStillLoadedAfterFastPaths).toBe(false);
      expect(sample.corpusLoadedAfterFirstUse).toBe(true);
    }
  }
});
