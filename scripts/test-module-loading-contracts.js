#!/usr/bin/env node
/**
 * Regression guards for classic-script loading while production code is split
 * into feature modules. These checks intentionally exercise manifest/import
 * contracts without requiring a browser or changing runtime behavior.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'extension');
const failures = [];
const pass = (message) => console.log('PASS:', message);
const fail = (message) => failures.push(message);
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

let manifest;
try {
  manifest = JSON.parse(read('extension/manifest.json'));
} catch (error) {
  console.error('FAIL: cannot parse extension/manifest.json:', error.message);
  process.exit(1);
}

const expectedContentScripts = [
  'regex-patterns.js',
  'kjv-corpus-word-index.js',
  'books.js',
  'book-aliases.js',
  'reference-core.js',
  'kings-bible-collector.js',
  'webster-collector.js',
  'source-page-collector.js',
  'source-bible-redirect.js',
  'multiverse-copy.js',
  'study-reference-capture.js',
  'criteria-search-navigation.js',
  'blb-auto-hyperlinker.js',
  'blb-passive-new-tab-targets.js',
  'blb-draggable-button.js',
  'blb-parse-popup.js',
  'blb-verse-link-navigation.js',
  'blb-page-selection-button.js',
  'multiverse-handoff.js',
  'multiverse-tool-view.js',
  'content.js'
];
const contentEntry = (manifest.content_scripts || []).find(entry =>
  (entry.js || []).includes('content.js')
);
if (!contentEntry) {
  fail('manifest declares a content-script entry containing content.js');
} else {
  const actual = contentEntry.js;
  const requiredPositions = expectedContentScripts.map(name => actual.indexOf(name));
  if (requiredPositions.some(index => index < 0)
      || requiredPositions.some((index, i) => i > 0 && index <= requiredPositions[i - 1])) {
    fail('content-script dependencies are present and ordered before content.js: '
      + expectedContentScripts.join(' -> '));
  } else {
    pass('content-script dependency order remains stable');
  }
  if (contentEntry.run_at !== 'document_start') {
    fail('content script remains configured for document_start');
  } else {
    pass('content script initialization timing remains document_start');
  }
}

const background = read('extension/background.js');
const importMatch = background.match(/^\s*importScripts\(([^;]+)\);/);
if (!importMatch) {
  fail('background service worker begins with its classic importScripts bootstrap');
} else {
  const imports = [...importMatch[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map(match => match[1]);
  const required = [
    'study-session-normalization.js',
    'multiverse-reference-helpers.js',
    'study-session-export.js',
    'selection-text-helpers.js',
    'omnibox-search-helpers.js',
    'regex-patterns.js',
    'kjv-corpus-word-index.js',
    'case-sensitive-search-core.js',
    'case-sensitive-routing.js',
    'books.js',
    'book-aliases.js',
    'reference-core.js'
  ];
  const positions = required.map(name => imports.indexOf(name));
  if (positions.some(index => index < 0)
      || positions.some((index, i) => i > 0 && index <= positions[i - 1])) {
    fail('service-worker imports retain dependency order: ' + required.join(' -> '));
  } else {
    pass('service-worker import dependency order remains stable');
  }
  const lazyVerseCorpusLoader = background.match(/async function ensureKjvVerseCorpusLoaded\(\) \{([\s\S]*?)\n\}/);
  if (!lazyVerseCorpusLoader
      || !lazyVerseCorpusLoader[1].includes("kjv-corpus-verses.js")
      || !lazyVerseCorpusLoader[1].includes("kjv-corpus-word-verse-index.js")
      || !lazyVerseCorpusLoader[1].includes("fetchPackagedJsonAssignment(")
      || !lazyVerseCorpusLoader[1].includes("Promise.all([")
      || !lazyVerseCorpusLoader[1].includes("Object.fromEntries(wordVerseEntries)")
      || !lazyVerseCorpusLoader[1].includes("kjvVerseCorpusLoadPromise")
      || !lazyVerseCorpusLoader[1].includes("kjvVerseCorpusLoadPromise = null")) {
    fail('normalized verse corpus and word-to-verse index are fetched together as validated data with retryable, promise-deduplicated loading');
  } else {
    pass('normalized verse corpus and word-to-verse index have a guarded, promise-deduplicated data loader');
  }
  for (const file of ['kjv-corpus-word-verse-index.js', 'kjv-corpus-verses.js']) {
    if (imports.includes(file)) {
      fail(file + ' is not imported during ordinary worker startup');
    } else {
      pass(file + ' is not imported during ordinary worker startup');
    }
  }
  if (!background.includes('await ensureKjvVerseCorpusLoaded();\n      const singleMatch = findSingleKjvPhraseMatch(phrase)')
      || !background.includes('if (!hasBooleanOperators) await ensureKjvVerseCorpusLoaded();\n  const singleKjvMatch =')
      || !background.includes('if (normalizeKjvPassageWords(source).length >= 5) await ensureKjvVerseCorpusLoaded();\n    if (wordCount >= KJV_PASSAGE_MIN_WORDS) await ensureKjvPhraseIndexLoaded();\n    const corpusRange = findKjvVerseRangeForSelection(source)')
      || !background.includes('await ensureKjvVerseCorpusLoaded();\n    const singleMatch = findSingleKjvPhraseMatch(cleanedText)')) {
    fail('omnibox, selection classification, and direct-verse optimizations await the corpus only at their data-dependent decision points');
  } else {
    pass('omnibox, selection classification, and direct-verse optimizations await corpus data at their decision points');
  }
  const lazyPhraseLoader = background.match(/async function ensureKjvPhraseIndexLoaded\(\) \{([\s\S]*?)\n\}/);
  if (!lazyPhraseLoader
      || !lazyPhraseLoader[1].includes('kjv-corpus-phrase-index.js')
      || !lazyPhraseLoader[1].includes('fetchPackagedJsonAssignment(')
      || !lazyPhraseLoader[1].includes('Object.freeze(index)')
      || !lazyPhraseLoader[1].includes('kjvPhraseIndexLoadPromise')
      || !lazyPhraseLoader[1].includes("');',\n        true")
      || !background.includes('allowTrailingObjectComma ? json.replace(')) {
    fail('KJV phrase candidate index is fetched as data with a guarded, promise-deduplicated loader');
  } else {
    pass('KJV phrase candidate index has a guarded, promise-deduplicated data loader');
  }
  const lazyWordsLoader = background.match(/async function ensureKjvCaseSensitiveWordsLoaded\(\) \{([\s\S]*?)\n\}/);
  if (!lazyWordsLoader
      || !lazyWordsLoader[1].includes("kjv-case-sensitive-words.js")
      || !lazyWordsLoader[1].includes('fetchPackagedJsonAssignment(')
      || !lazyWordsLoader[1].includes('new Set(words)')
      || !lazyWordsLoader[1].includes('kjvCaseSensitiveWordsLoadPromise')) {
    fail('case-sensitive routing words are fetched as data and shared across concurrent lazy loads');
  } else {
    pass('case-sensitive routing words have a guarded, promise-deduplicated loader');
  }
  const lazyCorpusLoader = background.match(/async function ensureKjvOriginalCaseCorpusLoaded\(\) \{([\s\S]*?)\n\}/);
  if (!lazyCorpusLoader
      || !lazyCorpusLoader[1].includes("typeof KJV_CORPUS_ORIGINAL_CASE !== 'undefined'")
      || !lazyCorpusLoader[1].includes("kjv-corpus-original-case.js")
      || !lazyCorpusLoader[1].includes("kjv-corpus-case-verse-index.js")
      || !lazyCorpusLoader[1].includes('fetchPackagedJsonAssignment(')
      || !lazyCorpusLoader[1].includes('Promise.all(')
      || !lazyCorpusLoader[1].includes('kjvOriginalCaseCorpusLoadPromise')) {
    fail('original-case corpus and case verse index are fetched as data and shared across concurrent lazy loads');
  } else {
    pass('original-case corpus and case verse index have a guarded, promise-deduplicated resource loader');
  }
  for (const file of ['kjv-case-sensitive-words.js', 'kjv-corpus-case-verse-index.js', 'kjv-corpus-original-case.js', 'kjv-corpus-phrase-index.js']) {
    if (background.includes("importScripts('" + file + "')")) {
      fail(file + ' is not imported during ordinary worker startup');
    } else {
      pass(file + ' is not imported during ordinary worker startup');
    }
  }
  if (!background.includes('await ensureKjvCaseSensitiveWordsLoaded();')
      || !background.includes('await ensureKjvOriginalCaseCorpusLoaded();')
      || !background.includes('await ensureKjvPhraseIndexLoaded();')) {
    fail('case-sensitive search and KJV phrase classification await their data at the respective decision points');
  } else {
    pass('case-sensitive search and KJV phrase classification await their data at the respective decision points');
  }
}

const dynamicFilesMatch = background.match(/const BLB_CONTENT_SCRIPT_FILES = \[([\s\S]*?)\];/);
if (!dynamicFilesMatch) {
  fail('runtime-injected content scripts declare their dependency list');
} else {
  const dynamicFiles = [...dynamicFilesMatch[1].matchAll(/['\"]([^'\"]+\.js)['\"]/g)].map(match => match[1]);
  if (!contentEntry || JSON.stringify(dynamicFiles) !== JSON.stringify(contentEntry.js || [])) {
    fail('runtime-injected content scripts exactly match the manifest content-script list and order');
  } else {
    pass('runtime-injected content scripts exactly match the manifest list and order');
  }
  const requiredDynamic = ['regex-patterns.js', 'kjv-corpus-word-index.js', 'books.js', 'book-aliases.js', 'reference-core.js', 'kings-bible-collector.js', 'webster-collector.js', 'source-page-collector.js', 'source-bible-redirect.js', 'multiverse-copy.js', 'study-reference-capture.js', 'criteria-search-navigation.js', 'blb-auto-hyperlinker.js', 'blb-passive-new-tab-targets.js', 'blb-draggable-button.js', 'blb-parse-popup.js', 'blb-verse-link-navigation.js', 'blb-page-selection-button.js', 'multiverse-handoff.js', 'multiverse-tool-view.js', 'content.js'];
  const positions = requiredDynamic.map(name => dynamicFiles.indexOf(name));
  if (positions.some(index => index < 0)
      || positions.some((index, i) => i > 0 && index <= positions[i - 1])) {
    fail('runtime-injected content scripts retain shared-core and feature module order: '
      + requiredDynamic.join(' -> '));
  } else {
    pass('runtime-injected content scripts retain feature module dependency order');
  }
}

const referenceCore = read('extension/reference-core.js');
if (!referenceCore.includes('function normalizeBibleReferenceText')
    || !referenceCore.includes('function resolveBibleReference')) {
  fail('shared reference core retains the normalization and resolution entry points');
} else {
  pass('shared reference-core entry points remain available');
}
if (/\b(?:document|window)\s*\./.test(referenceCore)) {
  fail('shared reference-core remains free of direct DOM/window property access');
} else {
  pass('shared reference-core has no direct DOM/window property access');
}

const content = read('extension/content.js');
if (!content.includes('window.__blbSuiteContentScriptFileExecutedV3')
    || !content.includes('(async function ()')) {
  fail('content script retains its file-execution marker and async initializer');
} else {
  pass('content script execution marker and async initializer remain present');
}
if (!content.includes('BLBShared.hostnames.blb') || !background.includes('BLBShared.hostnames.blb')) {
  fail('content script and service worker both consume the shared BLB identity API');
} else {
  pass('content script and service worker retain the shared BLB identity contract');
}

if (failures.length) {
  for (const message of failures) console.error('FAIL:', message);
  process.exitCode = 1;
} else {
  console.log('All module-loading contract checks passed.');
}
