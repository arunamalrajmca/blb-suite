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

  test('HTTP and corrupt compressed-sidecar failures fall back to original packaged data', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const originalFetch = self.fetch;
      const gzipFailures = [];
      const fallbackFiles = [];
      self.fetch = async (input, ...args) => {
        const url = String(input);
        if (url.endsWith('kjv-corpus-verses.json.gz')) {
          gzipFailures.push('http-503');
          return new Response('', { status:503 });
        }
        if (url.endsWith('kjv-corpus-word-verse-index.json.gz')) {
          gzipFailures.push('invalid-gzip');
          return new Response('not a gzip stream', { status:200 });
        }
        if (/kjv-corpus-(verses|word-verse-index)\.js(?:$|[?#])/.test(url)) {
          fallbackFiles.push(url.split('/').pop());
        }
        return originalFetch(input, ...args);
      };
      try {
        const [verses, wordVerseEntries] = await Promise.all([
          fetchPackagedGzipJson('kjv-corpus-verses.json.gz'),
          fetchPackagedGzipJson('kjv-corpus-word-verse-index.json.gz')
        ]);
        return {
          gzipFailures,
          fallbackFiles,
          verseCount:verses.length,
          wordEntryCount:wordVerseEntries.length
        };
      } finally {
        self.fetch = originalFetch;
      }
    });

    expect(result.gzipFailures).toEqual(['http-503', 'invalid-gzip']);
    expect(result.fallbackFiles).toEqual(expect.arrayContaining([
      'kjv-corpus-verses.js',
      'kjv-corpus-word-verse-index.js'
    ]));
    expect(result.verseCount).toBe(31102);
    expect(result.wordEntryCount).toBeGreaterThan(0);
  });

  test('concurrent loads are deduplicated and a failed load can be retried', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const originalFetch = self.fetch;
      let requests = 0;
      let gzipFailureInjected = false;
      let fallbackFailureInjected = false;
      self.fetch = async (input, ...args) => {
        requests++;
        const url = String(input);
        if (!gzipFailureInjected && url.endsWith('kjv-corpus-verses.json.gz')) {
          gzipFailureInjected = true;
          return new Response('', { status:503 });
        }
        if (!fallbackFailureInjected && url.endsWith('kjv-corpus-verses.js')) {
          fallbackFailureInjected = true;
          return new Response('', { status:503 });
        }
        return originalFetch(input, ...args);
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
    expect(result.requests).toBe(5);
    expect(result.versesLoaded).toBe(true);
    expect(result.indexLoaded).toBe(true);
  });
});


test('lazy corpus is reloaded correctly after a service-worker restart', async ({ context, extensionId, extensionWorker }) => {
  const initiallyLoaded = await extensionWorker.evaluate(async () => {
    await Promise.all([ensureKjvVerseCorpusLoaded(), ensureKjvPhraseIndexLoaded()]);
    return {
      verses: Array.isArray(KJV_CORPUS_VERSES),
      wordIndex: !!KJV_CORPUS_WORD_VERSE_INDEX,
      phraseIndex: !!KJV_CORPUS_PHRASE_INDEX
    };
  });
  expect(initiallyLoaded).toEqual({ verses: true, wordIndex: true, phraseIndex: true });

  const closeSupported = await extensionWorker.evaluate(() => {
    if (typeof self.close !== 'function') return false;
    self.close();
    return true;
  });
  expect(closeSupported).toBe(true);

  const restartedWorkerPromise = context.waitForEvent('serviceworker', { timeout: 20000 });
  const page = await context.newPage();
  try {
    await page.goto('chrome-extension://' + extensionId + '/popup.html', { waitUntil: 'domcontentloaded' });
    const restartedWorker = await restartedWorkerPromise;
    const state = await restartedWorker.evaluate(async () => {
      const initial = {
        verses: typeof KJV_CORPUS_VERSES !== 'undefined',
        wordIndex: typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined',
        phraseIndex: KJV_CORPUS_PHRASE_INDEX !== null
      };
      const reference = await classifySelectionForBlb('John 3:16');
      const word = await classifySelectionForBlb('grace');
      const afterFastPaths = {
        verses: typeof KJV_CORPUS_VERSES !== 'undefined',
        wordIndex: typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined'
      };
      const phrase = await classifySelectionForBlb('God is love');
      return {
        initial,
        referenceType: reference.type,
        wordType: word.type,
        afterFastPaths,
        phraseType: phrase.type,
        afterPhrase: {
          verses: Array.isArray(KJV_CORPUS_VERSES),
          wordIndex: !!KJV_CORPUS_WORD_VERSE_INDEX,
          phraseIndex: !!KJV_CORPUS_PHRASE_INDEX
        }
      };
    });
    expect(state.initial).toEqual({ verses: false, wordIndex: false, phraseIndex: false });
    expect(state.referenceType).toBe('REFERENCE');
    expect(state.wordType).toBe('KJV_WORD');
    expect(state.afterFastPaths).toEqual({ verses: false, wordIndex: false });
    expect(state.phraseType).toBe('KJV_PASSAGE');
    expect(state.afterPhrase).toEqual({ verses: true, wordIndex: true, phraseIndex: true });
  } finally {
    await page.close();
  }
});


test('interleaved 15-pair cold-start and first-corpus-use A/B against the pre-lazy baseline', async () => {
  // Keep ordinary browser suites fast; only the dedicated performance job
  // supplies BLB_PERF_OUTPUT and runs the paired benchmark.
  test.skip(!process.env.BLB_PERF_OUTPUT, 'runs only in the dedicated performance qualification job');
  test.setTimeout(300000);

  const repoRoot = path.resolve(__dirname, '../..');
  const baselineRef = process.env.BLB_CORPUS_BASELINE_SHA || '81887b46c9c6918f53b8155741dc535aa8192bf0';
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
    let scripts = [];
    const legacyMatch = source.match(/^\uFEFF?\s*importScripts\(([^;]+)\);/);

    if (legacyMatch) {
      // The current-main baseline uses one importScripts(...) statement.
      scripts = [...legacyMatch[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map(item => item[1]);
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
      source = source.replace(legacyMatch[0], replacement);
    } else {
      // The candidate now declares its ordered imports and imports each file
      // separately so startup failures can be attributed to a filename.
      const arrayMatch = source.match(/^\uFEFF?\s*const BLB_BACKGROUND_STARTUP_IMPORTS\s*=\s*(\[[\s\S]*?\]);/);
      const loopMatch = source.match(/for\s*\(const scriptFile of BLB_BACKGROUND_STARTUP_IMPORTS\)\s*\{\s*try\s*\{\s*importScripts\(scriptFile\);\s*\}\s*catch\s*\(error\)\s*\{[\s\S]*?\n  \}\n\}/);
      if (!arrayMatch || !loopMatch) {
        throw new Error('Unable to instrument either legacy or per-file service-worker import bootstrap');
      }
      scripts = [...arrayMatch[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map(item => item[1]);
      if (!scripts.length) throw new Error('No service-worker imports were found for A/B timing');
      const importCall = '    importScripts(scriptFile);';
      if (!loopMatch[0].includes(importCall)) {
        throw new Error('Per-file service-worker import loop did not contain its expected import call');
      }
      source = source.replace(arrayMatch[0],
        'const __blbProfileBootstrapAt = performance.now();\n'
        + 'const __blbProfilePhases = [];\n'
        + arrayMatch[0]);
      source = source.replace(importCall,
        '    const __blbImportStartedAt = performance.now();\n'
        + importCall + '\n'
        + "    __blbProfilePhases.push({ phase: 'service-worker-importScript', script: scriptFile, durationMs: performance.now() - __blbImportStartedAt });");
      const updatedLoopMatch = source.match(/for\s*\(const scriptFile of BLB_BACKGROUND_STARTUP_IMPORTS\)\s*\{\s*try\s*\{[\s\S]*?\n  \}\n\}/);
      if (!updatedLoopMatch) throw new Error('Unable to locate instrumented per-file import loop');
      source = source.replace(updatedLoopMatch[0],
        updatedLoopMatch[0] + '\n'
        + 'globalThis.__BLB_PROFILE_STARTUP__ = { bootstrapAt: __blbProfileBootstrapAt, phases: __blbProfilePhases };\n'
        + 'globalThis.__BLB_PROFILE_LOAD__ = { events: [] };');
    }

    const fetchStart = "  const response = await fetch(chrome.runtime.getURL(filename));";
    const fetchEnd = "  const source = await response.text();";
    const extractStart = "  const start = source.indexOf(assignment);";
    const extractEnd = "  const json = source.slice(start + assignment.length, end);";
    const parseLine = source.split('\n').find(line =>
      line.trim().startsWith('return JSON.parse(allowTrailingObjectComma ? json.replace(')
    );
    if (!source.includes(fetchStart) || !source.includes(fetchEnd) || !parseLine) {
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
    const gzipEnd = source.indexOf('\nasync function ensureKjvVerseCorpusLoaded()', gzipStart);
    if (gzipStart >= 0 && gzipEnd > gzipStart) {
      let gzipLoader = source.slice(gzipStart, gzipEnd);
      const gzipFetchLine = "  const response = await fetch(chrome.runtime.getURL(filename));";
      const gzipStreamLine = "  const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));";
      const gzipJsonLine = "  return await new Response(decompressed).json();";
      if (!gzipLoader.includes(gzipFetchLine)
          || !gzipLoader.includes(gzipStreamLine)
          || !gzipLoader.includes(gzipJsonLine)) {
        throw new Error('Unable to instrument the production gzip fetch/decompress/JSON path');
      }
      gzipLoader = gzipLoader.replace(gzipFetchLine, [
        '  const __blbGzipFetchStarted = performance.now();',
        gzipFetchLine,
        "  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-gzip-fetch', file: filename, durationMs: performance.now() - __blbGzipFetchStarted });"
      ].join('\n'));
      gzipLoader = gzipLoader.replace(gzipStreamLine, [
        '  const __blbGzipReadStarted = performance.now();',
        gzipStreamLine
      ].join('\n'));
      gzipLoader = gzipLoader.replace(gzipJsonLine, [
        '  const __blbGzipText = await new Response(decompressed).text();',
        "  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-gzip-decompress-read', file: filename, durationMs: performance.now() - __blbGzipReadStarted });",
        '  const __blbGzipParseStarted = performance.now();',
        '  const __blbDecoded = JSON.parse(__blbGzipText);',
        "  globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-gzip-json-parse', file: filename, durationMs: performance.now() - __blbGzipParseStarted });",
        '  return __blbDecoded;'
      ].join('\n'));
      source = source.slice(0, gzipStart) + gzipLoader + source.slice(gzipEnd);
    }
    const phraseLoaderStart = source.indexOf('async function ensureKjvPhraseIndexLoaded() {');
    const phraseLoaderEnd = source.indexOf('\nasync function ensureKjvCaseSensitiveWordsLoaded()', phraseLoaderStart);
    if (phraseLoaderStart >= 0 && phraseLoaderEnd > phraseLoaderStart) {
      let phraseLoader = source.slice(phraseLoaderStart, phraseLoaderEnd);
      const phraseValidationLine = "      if (!index || typeof index !== 'object' || Array.isArray(index) || !Object.keys(index).length) {";
      const phrasePublishLine = "      KJV_CORPUS_PHRASE_INDEX = Object.freeze(index);";
      if (!phraseLoader.includes(phraseValidationLine) || !phraseLoader.includes(phrasePublishLine)) {
        throw new Error('Unable to instrument phrase-index validation and publication');
      }
      phraseLoader = phraseLoader.replace(phraseValidationLine, [
        '      const __blbPhraseValidationStarted = performance.now();',
        phraseValidationLine
      ].join('\n'));
      phraseLoader = phraseLoader.replace(phrasePublishLine, [
        "      globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'phrase-index-validation-freeze', durationMs: performance.now() - __blbPhraseValidationStarted });",
        phrasePublishLine
      ].join('\n'));
      source = source.slice(0, phraseLoaderStart) + phraseLoader + source.slice(phraseLoaderEnd);
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
          phraseIndexLoadedAfterFirstUse: !!KJV_CORPUS_PHRASE_INDEX,
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
  const profileMedian = (rows, phase, filePart = '') => {
    const values = rows.flatMap(row => row.firstUseProfileEvents
      .filter(event => event.phase === phase && (!filePart || String(event.file || '').includes(filePart)))
      .map(event => event.durationMs));
    return values.length ? median(values) : null;
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
      firstPhraseUseMs: median(rows.map(row => row.firstPhraseUseMs)),
      profile: {
        verses: {
          fetchMs: profileMedian(rows, 'packaged-gzip-fetch', 'kjv-corpus-verses'),
          decompressReadMs: profileMedian(rows, 'packaged-gzip-decompress-read', 'kjv-corpus-verses'),
          jsonParseMs: profileMedian(rows, 'packaged-gzip-json-parse', 'kjv-corpus-verses')
        },
        wordVerseIndex: {
          fetchMs: profileMedian(rows, 'packaged-gzip-fetch', 'kjv-corpus-word-verse-index'),
          decompressReadMs: profileMedian(rows, 'packaged-gzip-decompress-read', 'kjv-corpus-word-verse-index'),
          jsonParseMs: profileMedian(rows, 'packaged-gzip-json-parse', 'kjv-corpus-word-verse-index')
        },
        phraseIndex: {
          fetchMs: profileMedian(rows, 'packaged-gzip-fetch', 'kjv-corpus-phrase-index'),
          decompressReadMs: profileMedian(rows, 'packaged-gzip-decompress-read', 'kjv-corpus-phrase-index'),
          jsonParseMs: profileMedian(rows, 'packaged-gzip-json-parse', 'kjv-corpus-phrase-index'),
          validationAndFreezeMs: profileMedian(rows, 'phrase-index-validation-freeze')
        },
        corpusValidationMs: profileMedian(rows, 'corpus-data-validation'),
        wordVerseIndexBuildMs: profileMedian(rows, 'word-verse-index-build'),
        wordIndexValidationMs: profileMedian(rows, 'word-index-validation'),
        rangeResolverMs: profileMedian(rows, 'downstream-corpus-classification'),
        fallbackReadMs: profileMedian(rows, 'packaged-json-read'),
        fallbackParseMs: profileMedian(rows, 'packaged-json-parse')
      }
    };
  };
  const pairedChanges = Array.from({ length: 15 }, (_, index) => {
    const repetition = index + 1;
    const baseline = samples.find(sample => sample.variant === 'baseline' && sample.repetition === repetition);
    const candidate = samples.find(sample => sample.variant === 'candidate' && sample.repetition === repetition);
    if (!baseline || !candidate) throw new Error('Missing interleaved A/B sample pair ' + repetition);
    const baselineCombinedMs = baseline.startupToFirstEvaluationMs + baseline.firstCorpusUseMs;
    const candidateCombinedMs = candidate.startupToFirstEvaluationMs + candidate.firstCorpusUseMs;
    const percentChange = (before, after) => before ? ((after - before) / before) * 100 : null;
    return {
      repetition,
      baselineCombinedMs,
      candidateCombinedMs,
      deltaMs: {
        startup: candidate.startupToFirstEvaluationMs - baseline.startupToFirstEvaluationMs,
        firstCorpusUse: candidate.firstCorpusUseMs - baseline.firstCorpusUseMs,
        combinedStartupToFirstUse: candidateCombinedMs - baselineCombinedMs,
        warmCorpusUse: candidate.warmCorpusUseMs - baseline.warmCorpusUseMs,
        referenceOnly: candidate.referenceOnlyMs - baseline.referenceOnlyMs,
        singleWord: candidate.singleWordMs - baseline.singleWordMs
      },
      percentChange: {
        startup: percentChange(baseline.startupToFirstEvaluationMs, candidate.startupToFirstEvaluationMs),
        firstCorpusUse: percentChange(baseline.firstCorpusUseMs, candidate.firstCorpusUseMs),
        combinedStartupToFirstUse: percentChange(baselineCombinedMs, candidateCombinedMs),
        warmCorpusUse: percentChange(baseline.warmCorpusUseMs, candidate.warmCorpusUseMs)
      }
    };
  });
  const pairedMedianChanges = {
    startupDeltaMs: median(pairedChanges.map(pair => pair.deltaMs.startup)),
    startupPercentChange: median(pairedChanges.map(pair => pair.percentChange.startup)),
    firstCorpusUseDeltaMs: median(pairedChanges.map(pair => pair.deltaMs.firstCorpusUse)),
    firstCorpusUsePercentChange: median(pairedChanges.map(pair => pair.percentChange.firstCorpusUse)),
    combinedStartupToFirstUseDeltaMs: median(pairedChanges.map(pair => pair.deltaMs.combinedStartupToFirstUse)),
    combinedStartupToFirstUsePercentChange: median(pairedChanges.map(pair => pair.percentChange.combinedStartupToFirstUse)),
    warmCorpusUseDeltaMs: median(pairedChanges.map(pair => pair.deltaMs.warmCorpusUse))
  };
  const candidateAssets = [
    'kjv-corpus-verses.json.gz',
    'kjv-corpus-word-verse-index.json.gz',
    'kjv-corpus-phrase-index.json.gz'
  ].map(file => ({ file, bytes: fs.statSync(path.join(candidateRoot, file)).size }));
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const summary = {
    baselineSha,
    candidateSha,
    candidateAssets,
    baseline: summarize('baseline'),
    candidate: summarize('candidate'),
    pairedMedianChanges,
    pairedChanges,
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
    const isLazyCandidate = sample.variant === 'candidate';
    // The fixed pre-lazy baseline eagerly imports both large corpus resources;
    // the candidate must keep them out of startup and reference/single-word paths.
    expect(sample.corpusLoadedAtStartup).toBe(!isLazyCandidate);
    expect(sample.corpusStillLoadedAfterFastPaths).toBe(!isLazyCandidate);
    expect(sample.corpusLoadedAfterFirstUse).toBe(true);
    expect(sample.phraseIndexLoadedAfterFirstUse).toBe(true);
    if (isLazyCandidate) {
      const gzipFiles = new Set(sample.firstUseProfileEvents
        .filter(event => event.phase === 'packaged-gzip-fetch')
        .map(event => event.file));
      expect([...gzipFiles]).toEqual(expect.arrayContaining([
        'kjv-corpus-verses.json.gz',
        'kjv-corpus-word-verse-index.json.gz',
        'kjv-corpus-phrase-index.json.gz'
      ]));
      expect(sample.firstUseProfileEvents.some(event => event.phase === 'packaged-gzip-decompress-read')).toBe(true);
      expect(sample.firstUseProfileEvents.some(event => event.phase === 'packaged-gzip-json-parse')).toBe(true);
      expect(sample.firstUseProfileEvents.some(event => event.phase === 'packaged-json-read')).toBe(false);
    }
  }
});
