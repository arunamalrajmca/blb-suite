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
        indexLoaded: (typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined' && !!KJV_CORPUS_WORD_VERSE_INDEX)
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

  test('short exact whitelist phrases verify against verse text without loading the large indexes', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const decision = await classifySelectionForBlb('God is love');
      return {
        decisionType: decision.type,
        query: decision.kjvPassageQuery,
        versesLoaded: Array.isArray(KJV_CORPUS_VERSES),
        wordIndexLoaded: (typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined' && !!KJV_CORPUS_WORD_VERSE_INDEX),
        phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX,
        exactMatch: !!findExactKjvPhraseInLoadedCorpus(['god', 'is', 'love'])
      };
    });

    expect(result.decisionType).toBe('KJV_PASSAGE');
    expect(result.query).toBe('"god is love"');
    expect(result.versesLoaded).toBe(true);
    expect(result.wordIndexLoaded).toBe(false);
    expect(result.phraseIndexLoaded).toBe(false);
    expect(result.exactMatch).toBe(true);
  });

  test('non-whitelist short phrases retain indexed corpus verification', async ({ extensionWorker }) => {
    const result = await extensionWorker.evaluate(async () => {
      const decision = await classifySelectionForBlb('For God so loved');
      return {
        decisionType: decision.type,
        query: decision.kjvPassageQuery,
        versesLoaded: Array.isArray(KJV_CORPUS_VERSES),
        wordIndexLoaded: (typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined' && !!KJV_CORPUS_WORD_VERSE_INDEX),
        phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX
      };
    });

    expect(result.decisionType).toBe('KJV_PASSAGE');
    expect(result.query).toBeTruthy();
    expect(result.versesLoaded).toBe(true);
    expect(result.wordIndexLoaded).toBe(true);
    expect(result.phraseIndexLoaded).toBe(true);
  });

  test('lazy corpus state is safely reinitialized in a fresh service-worker process', async ({ extensionPath }) => {
    const launchExtensionContext = () => chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
        '--disable-extensions-except=' + extensionPath,
        '--load-extension=' + extensionPath,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    const waitForWorker = async context => {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
      return worker;
    };

    const firstContext = await launchExtensionContext();
    try {
      const firstWorker = await waitForWorker(firstContext);
      const beforeRestart = await firstWorker.evaluate(async () => {
        const decision = await classifySelectionForBlb('God is love');
        return {
          type: decision.type,
          query: decision.kjvPassageQuery,
          versesLoaded: Array.isArray(KJV_CORPUS_VERSES),
          wordIndexLoaded: typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined'
            && !!KJV_CORPUS_WORD_VERSE_INDEX,
          phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX
        };
      });
      expect(beforeRestart).toEqual({
        type: 'KJV_PASSAGE',
        query: '"god is love"',
        versesLoaded: true,
        wordIndexLoaded: false,
        phraseIndexLoaded: false
      });
    } finally {
      await firstContext.close();
    }

    // A new persistent browser context creates a new extension service-worker
    // process with fresh module globals, matching the state boundary after a
    // browser-managed service-worker termination/restart.
    const restartedContext = await launchExtensionContext();
    try {
      const restartedWorker = await waitForWorker(restartedContext);
      const afterRestart = await restartedWorker.evaluate(async () => {
        const initial = {
          versesLoaded: typeof KJV_CORPUS_VERSES !== 'undefined',
          wordIndexLoaded: typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined'
        };
        const reference = await classifySelectionForBlb('John 3:16');
        const word = await classifySelectionForBlb('grace');
        const afterFastPaths = {
          versesLoaded: typeof KJV_CORPUS_VERSES !== 'undefined',
          wordIndexLoaded: typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined'
        };
        const phrase = await classifySelectionForBlb('God is love');
        return {
          initial,
          referenceType: reference.type,
          wordType: word.type,
          afterFastPaths,
          phraseType: phrase.type,
          phraseQuery: phrase.kjvPassageQuery,
          versesLoadedAfterPhrase: Array.isArray(KJV_CORPUS_VERSES),
          wordIndexLoadedAfterPhrase: typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined'
            && !!KJV_CORPUS_WORD_VERSE_INDEX,
          phraseIndexLoadedAfterPhrase: !!KJV_CORPUS_PHRASE_INDEX
        };
      });

      expect(afterRestart.initial).toEqual({ versesLoaded:false, wordIndexLoaded:false });
      expect(afterRestart.referenceType).toBe('REFERENCE');
      expect(afterRestart.wordType).toBe('KJV_WORD');
      expect(afterRestart.afterFastPaths).toEqual({ versesLoaded:false, wordIndexLoaded:false });
      expect(afterRestart.phraseType).toBe('KJV_PASSAGE');
      expect(afterRestart.phraseQuery).toBe('"god is love"');
      expect(afterRestart.versesLoadedAfterPhrase).toBe(true);
      expect(afterRestart.wordIndexLoadedAfterPhrase).toBe(false);
      expect(afterRestart.phraseIndexLoadedAfterPhrase).toBe(false);
    } finally {
      await restartedContext.close();
    }
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
          wordIndexLoaded: (typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined' && !!KJV_CORPUS_WORD_VERSE_INDEX),
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
        indexLoaded: (typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined' && !!KJV_CORPUS_WORD_VERSE_INDEX)
      };
    });

    expect(result.firstAttemptFailed).toBe(true);
    // The word index succeeds during the first parallel attempt and is retained;
    // only the failed verse asset is retried.
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

  // Build the same ignored gzip sidecars for the current-main baseline; without
  // them the baseline silently falls back to the slower uncompressed JS assets.
  execFileSync(process.execPath, [
    path.resolve(repoRoot, 'scripts/generate-kjv-gzip-assets.cjs'),
    path.join(baselineRoot, 'extension')
  ], { cwd: repoRoot, stdio: 'pipe' });

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
      const gzipFetchCall = 'const response = await fetch(chrome.runtime.getURL(filename));';
      const gzipDecodeCall = "const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));";
      const gzipJsonReturn = 'return await new Response(decompressed).json();';
      if (!gzipLoader.includes(gzipFetchCall)
          || !gzipLoader.includes(gzipDecodeCall)
          || !gzipLoader.includes(gzipJsonReturn)) {
        throw new Error('Unable to instrument gzip fetch/decompress/parse phases');
      }
      gzipLoader = gzipLoader.replace(gzipFetchCall,
        'const __blbGzipFetchStarted = performance.now();\n    ' + gzipFetchCall
        + "\n    globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-gzip-fetch', file: filename, durationMs: performance.now() - __blbGzipFetchStarted });");
      gzipLoader = gzipLoader.replace(gzipDecodeCall,
        'const __blbGzipDecodeStarted = performance.now();\n    ' + gzipDecodeCall);
      gzipLoader = gzipLoader.replace(gzipJsonReturn,
        'const __blbDecompressedText = await new Response(decompressed).text();\n'
        + "    globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-gzip-decompress-read', file: filename, durationMs: performance.now() - __blbGzipDecodeStarted });\n"
        + '    const __blbJsonParseStarted = performance.now();\n'
        + '    const __blbDecoded = JSON.parse(__blbDecompressedText);\n'
        + "    globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'packaged-gzip-json-parse', file: filename, durationMs: performance.now() - __blbJsonParseStarted });\n"
        + '    return __blbDecoded;');
      source = source.slice(0, gzipStart) + gzipLoader + source.slice(gzipEnd);
    }
    const fromEntries = "      const wordVerseIndex = Object.fromEntries(wordVerseEntries);";
    source = source.replace(fromEntries,
      "      const __blbIndexBuildStarted = performance.now();\n" + fromEntries +
      "\n      globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'word-verse-index-build', durationMs: performance.now() - __blbIndexBuildStarted });");
    const corpusValidationStart = "      if (!Array.isArray(verseEntries) || verseEntries.length !== 31102) {";
    source = source.replace(corpusValidationStart,
      "      const __blbCorpusValidationStarted = performance.now();\n" + corpusValidationStart);
    const wordIndexValidationStart = "      if (!wordVerseIndex || typeof wordVerseIndex !== 'object'";
    source = source.replace(wordIndexValidationStart,
      "      const __blbWordIndexValidationStarted = performance.now();\n" + wordIndexValidationStart);
    const verseAssignment = "      self.KJV_CORPUS_VERSES = verseEntries;";
    source = source.replace(verseAssignment,
      "      globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'corpus-data-validation', durationMs: performance.now() - __blbCorpusValidationStarted });\n" + verseAssignment);
    const wordIndexAssignment = "      self.KJV_CORPUS_WORD_VERSE_INDEX = wordVerseIndex;";
    source = source.replace(wordIndexAssignment,
      "      globalThis.__BLB_PROFILE_LOAD__?.events.push({ phase: 'word-index-validation', durationMs: performance.now() - __blbWordIndexValidationStarted });\n" + wordIndexAssignment);
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

        // First try the common exact whitelist phrase. The candidate should
        // need only normalized verse text; the current-main baseline also loads
        // its word and phrase indexes for this same classification.
        const firstPhraseStartedAt = performance.now();
        const phrase = await classifySelectionForBlb('God is love');
        const firstPhraseUseMs = performance.now() - firstPhraseStartedAt;
        const firstUseProfileEvents = [...(globalThis.__BLB_PROFILE_LOAD__?.events || [])];
        const afterFirstPhrase = {
          versesLoaded: Array.isArray(KJV_CORPUS_VERSES),
          wordIndexLoaded: (typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined' && !!KJV_CORPUS_WORD_VERSE_INDEX),
          phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX
        };

        // A longer exact passage needs the indexed word→verse resolver. This
        // measures the deferred index load separately from the short-phrase path.
        const deferredStartedAt = performance.now();
        const passage = await classifySelectionForBlb('For God so loved the world');
        const deferredWordIndexUseMs = performance.now() - deferredStartedAt;
        const deferredUseProfileEvents = [...(globalThis.__BLB_PROFILE_LOAD__?.events || [])];
        const afterDeferredUse = {
          versesLoaded: Array.isArray(KJV_CORPUS_VERSES),
          wordIndexLoaded: (typeof KJV_CORPUS_WORD_VERSE_INDEX !== 'undefined' && !!KJV_CORPUS_WORD_VERSE_INDEX),
          phraseIndexLoaded: !!KJV_CORPUS_PHRASE_INDEX
        };

        const warmStartedAt = performance.now();
        const warmPassage = await classifySelectionForBlb('For God so loved the world');
        const warmCorpusUseMs = performance.now() - warmStartedAt;
        const warmUseProfileEvents = [...(globalThis.__BLB_PROFILE_LOAD__?.events || [])];

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
          afterFirstPhrase,
          afterDeferredUse,
          referenceType: reference.type,
          wordType: word.type,
          passageType: passage.type,
          warmPassageType: warmPassage.type,
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
          firstPhraseUseMs,
          deferredWordIndexUseMs,
          deferredUseProfileEvents,
          warmCorpusUseMs,
          warmUseProfileEvents
        };
      }, { variant, repetition });
    } finally {
      await context.close();
    }
  };

  const samples = [];
  const performanceOutputPath = process.env.BLB_PERF_OUTPUT || path.join(repoRoot, 'blb-corpus-ab-results.jsonl');
  fs.writeFileSync(performanceOutputPath, '');
  try {
    for (let repetition = 1; repetition <= 15; repetition++) {
      const order = repetition % 2 === 1
        ? ['baseline', 'candidate']
        : ['candidate', 'baseline'];
      for (const variant of order) {
        const sample = await measureColdRun(variants[variant], variant, repetition);
        samples.push(sample);
        // Persist every raw observation immediately so later failures do not
        // leave the downloadable workflow artifact empty.
        fs.appendFileSync(performanceOutputPath, JSON.stringify({
          scenario:'kjv-short-whitelist-first-use-ab',
          baselineSha,
          sample
        }) + '\\n');
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
      firstPhraseUseMs: median(rows.map(row => row.firstPhraseUseMs)),
      deferredWordIndexUseMs: median(rows.map(row => row.deferredWordIndexUseMs)),
      warmCorpusUseMs: median(rows.map(row => row.warmCorpusUseMs))
    };
  };
  const metricKeys = [
    'startupToFirstEvaluationMs',
    'importScriptsMs',
    'firstPhraseUseMs',
    'deferredWordIndexUseMs',
    'warmCorpusUseMs',
    'referenceOnlyMs',
    'singleWordMs'
  ];
  const pairedChanges = Object.fromEntries(metricKeys.map(key => {
    const pairs = [];
    for (let repetition = 1; repetition <= 15; repetition++) {
      const baseline = samples.find(row => row.variant === 'baseline' && row.repetition === repetition);
      const candidate = samples.find(row => row.variant === 'candidate' && row.repetition === repetition);
      if (!baseline || !candidate) continue;
      const before = baseline[key];
      const after = candidate[key];
      pairs.push({
        repetition,
        baselineMs:before,
        candidateMs:after,
        deltaMs:after-before,
        percentChange:before ? (after-before)/before*100 : null
      });
    }
    const deltas = pairs.map(pair => pair.deltaMs);
    const percentages = pairs.map(pair => pair.percentChange).filter(Number.isFinite);
    return [key, {
      pairs:pairs.length,
      medianDeltaMs:median(deltas),
      medianPercentChange:median(percentages),
      improvedPairs:pairs.filter(pair => pair.deltaMs < 0).length,
      paired:pairs
    }];
  }));
  const summary = {
    baselineSha,
    baseline: summarize('baseline'),
    candidate: summarize('candidate'),
    pairedChanges,
    rawSamples: samples
  };
  const output = JSON.stringify({ scenario: 'kjv-short-whitelist-first-use-ab', ...summary });
  fs.appendFileSync(performanceOutputPath, output + '\\n');
  console.log('BLB_CORPUS_AB_OUTPUT ' + performanceOutputPath);
  console.log('BLB_CORPUS_AB_SUMMARY ' + output);

  for (const sample of samples) {
    expect(sample.referenceType).toBe('REFERENCE');
    expect(sample.wordType).toBe('KJV_WORD');
    expect(sample.passageType).toBe('KJV_REFERENCE_RANGE');
    // The lazy-loading experiment must preserve the baseline classification
    // for both variants; only the data-loading timing is allowed to differ.
    expect(sample.phraseType).toBe('KJV_PASSAGE');
    expect(sample.phraseQuery).toBe('"god is love"');
    expect(sample.passageRef).toEqual({ book: 'john', chapter: 3, from: 16, to: 16 });
    // Both variants preserve lazy startup. The candidate short-phrase path
    // loads only verse text; the word index remains deferred until indexed
    // reference/range resolution is requested.
    expect(sample.corpusLoadedAtStartup).toBe(false);
    expect(sample.corpusStillLoadedAfterFastPaths).toBe(false);
    expect(sample.afterFirstPhrase.versesLoaded).toBe(true);
    expect(sample.afterDeferredUse.versesLoaded).toBe(true);
    expect(sample.afterDeferredUse.wordIndexLoaded).toBe(true);
    if (sample.variant === 'baseline') {
      expect(sample.afterFirstPhrase.wordIndexLoaded).toBe(true);
      expect(sample.afterFirstPhrase.phraseIndexLoaded).toBe(true);
    } else {
      expect(sample.afterFirstPhrase.wordIndexLoaded).toBe(false);
      expect(sample.afterFirstPhrase.phraseIndexLoaded).toBe(false);
      expect(sample.afterDeferredUse.phraseIndexLoaded).toBe(false);
    }
    expect(sample.warmPassageType).toBe('KJV_REFERENCE_RANGE');
  }
});
