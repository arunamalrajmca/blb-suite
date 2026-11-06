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
        exactMatch: findSingleKjvPhraseMatch('For God so loved the world')?.slice(0, 3)
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


test('interleaved cold-start and first-corpus-use A/B against current main', async () => {
  // The exhaustive audit supplies BLB_PERF_OUTPUT. Keep ordinary focused
  // browser runs fast; the labeled audit performs the paired benchmark.
  test.skip(!process.env.CI && !process.env.BLB_PERF_OUTPUT, 'runs in CI or when an explicit performance output path is supplied');
  test.setTimeout(180000);

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
    const replacement = 'globalThis.__BLB_PROFILE_STARTUP__ = { bootstrapAt: performance.now(), phases: [] };\n'
      + 'for (const __blbScript of ' + JSON.stringify(scripts) + ') {\n'
      + '  const __blbImportStartedAt = performance.now();\n'
      + '  importScripts(__blbScript);\n'
      + "  globalThis.__BLB_PROFILE_STARTUP__.phases.push({ phase: 'service-worker-importScript', script: __blbScript, durationMs: performance.now() - __blbImportStartedAt });\n"
      + '}';
    source = source.replace(match[0], replacement);
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

        const firstUseStartedAt = performance.now();
        const passage = await classifySelectionForBlb('For God so loved the world');
        const firstCorpusUseMs = performance.now() - firstUseStartedAt;

        const warmStartedAt = performance.now();
        const warmPassage = await classifySelectionForBlb('For God so loved the world');
        const warmCorpusUseMs = performance.now() - warmStartedAt;

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
          warmPassageType: warmPassage.type,
          passageRef: passage.directRef ? {
            book: passage.directRef.book,
            chapter: passage.directRef.chapter,
            from: passage.directRef.from,
            to: passage.directRef.to
          } : null,
          referenceOnlyMs,
          singleWordMs,
          firstCorpusUseMs,
          warmCorpusUseMs
        };
      }, { variant, repetition });
    } finally {
      await context.close();
    }
  };

  const samples = [];
  try {
    for (let repetition = 1; repetition <= 5; repetition++) {
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
      warmCorpusUseMs: median(rows.map(row => row.warmCorpusUseMs))
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
    expect(sample.warmPassageType).toBe('KJV_REFERENCE_RANGE');
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
