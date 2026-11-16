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
const importMatch = background.match(/const BLB_BACKGROUND_STARTUP_IMPORTS = \[([\s\S]*?)\];/);
if (!importMatch) {
  fail('background service worker declares its classic importScripts bootstrap');
} else {
  const imports = [...importMatch[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map(match => match[1]);
  if (!background.includes('importScripts(scriptFile)')) fail('background imports each declared startup dependency individually');
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
  const lazyVerseEntriesLoader = background.match(/async function ensureKjvVerseEntriesLoaded\(\) \{([\s\S]*?)\n\}/);
  const lazyWordVerseIndexLoader = background.match(/async function ensureKjvWordVerseIndexLoaded\(\) \{([\s\S]*?)\n\}/);
  const combinedVerseCorpusLoader = background.match(/async function ensureKjvVerseCorpusLoaded\(\) \{([\s\S]*?)\n\}/);
  if (!lazyVerseEntriesLoader
      || !lazyVerseEntriesLoader[1].includes("kjv-corpus-verses.json.gz")
      || !lazyVerseEntriesLoader[1].includes("fetchPackagedGzipJson(")
      || !lazyVerseEntriesLoader[1].includes("verseEntries.length !== 31102")
      || !lazyVerseEntriesLoader[1].includes("kjvVerseEntriesLoadPromise")
      || !lazyVerseEntriesLoader[1].includes("kjvVerseEntriesLoadPromise = null")
      || !lazyWordVerseIndexLoader
      || !lazyWordVerseIndexLoader[1].includes("kjv-corpus-word-verse-index.json.gz")
      || !lazyWordVerseIndexLoader[1].includes("fetchPackagedGzipJson(")
      || !lazyWordVerseIndexLoader[1].includes("Object.fromEntries(wordVerseEntries)")
      || !lazyWordVerseIndexLoader[1].includes("kjvWordVerseIndexLoadPromise")
      || !lazyWordVerseIndexLoader[1].includes("kjvWordVerseIndexLoadPromise = null")
      || !combinedVerseCorpusLoader
      || !combinedVerseCorpusLoader[1].includes("Promise.all([")
      || !combinedVerseCorpusLoader[1].includes("ensureKjvVerseEntriesLoaded()")
      || !combinedVerseCorpusLoader[1].includes("ensureKjvWordVerseIndexLoaded()")
      || !background.includes("new DecompressionStream('gzip')")
      || !background.includes('if (!response.ok || !response.body)')
      || !background.includes('DecompressionStream is unavailable')
      || !background.includes('return loadOriginalData(error);')
      || !background.includes('fallbackAssignments')) {
    fail('normalized verse corpus and word-to-verse index have separate validated, retryable, promise-deduplicated loaders plus a combined indexed-path loader');
  } else {
    pass('normalized verse corpus and word-to-verse index have separate guarded loaders and a combined indexed-path loader');
  }
  const shortWhitelistFastPath = background.indexOf('const shortPhraseWords = normalizeKjvPassageWords(remainingText);');
  const indexedCriteriaPath = background.indexOf('if (remainingWordCount >= KJV_PASSAGE_MIN_WORDS) {', shortWhitelistFastPath);
  const shortWhitelistBlock = shortWhitelistFastPath >= 0 && indexedCriteriaPath > shortWhitelistFastPath
    ? background.slice(shortWhitelistFastPath, indexedCriteriaPath)
    : '';
  const lazyLoadingRegression = read('tests/browser/kjv-corpus-lazy-loading.spec.js');
  if (!shortWhitelistBlock
      || !shortWhitelistBlock.includes('KJV_PASSAGE_SHORT_WHITELIST.has(shortPhrase)')
      || !shortWhitelistBlock.includes('makeQuotedCriteriaOrQuery([shortPhrase])')
      || !shortWhitelistBlock.includes("return {valid:true, type:'KJV_PASSAGE'")
      || shortWhitelistBlock.includes('ensureKjvVerseEntriesLoaded')
      || shortWhitelistBlock.includes('findExactKjvPhraseInLoadedCorpus')
      || !lazyLoadingRegression.includes('every curated short-whitelist phrase is present in the normalized KJV corpus')
      || !lazyLoadingRegression.includes('await ensureKjvVerseEntriesLoaded();')
      || !lazyLoadingRegression.includes('findExactKjvPhraseInLoadedCorpus(phrase.split(/\\s+/))')) {
    fail('short whitelist phrases bypass runtime corpus loading and are validated against normalized KJV verse text by regression coverage');
  } else {
    pass('short whitelist phrases bypass runtime corpus loading and retain corpus-backed whitelist validation');
  }
  for (const file of ['kjv-corpus-word-verse-index.js', 'kjv-corpus-verses.js']) {
    if (imports.includes(file)) {
      fail(file + ' is not imported during ordinary worker startup');
    } else {
      pass(file + ' is not imported during ordinary worker startup');
    }
  }
  if (!background.includes("fetchPackagedGzipJson('kjv-corpus-phrase-index.json.gz')")) {
    fail('phrase candidate index is loaded from the generated compressed package asset');
  } else {
    pass('phrase candidate index uses the generated compressed package asset');
  }
  const corpusRangeCallIndex = background.indexOf('const corpusRange = findKjvVerseRangeForSelection(source)');
  const residualCriteriaBranchIndex = background.indexOf('if (remainingWordCount >= KJV_PASSAGE_MIN_WORDS) {');
  const deferredPhraseIndexLoadIndex = background.indexOf('ensureKjvPhraseIndexLoaded()', residualCriteriaBranchIndex);
  const phraseIndexLoadsAfterRangeCheck = corpusRangeCallIndex >= 0
    && residualCriteriaBranchIndex > corpusRangeCallIndex
    && deferredPhraseIndexLoadIndex > residualCriteriaBranchIndex;
  if (!background.includes('await ensureKjvVerseCorpusLoaded();\n      const singleMatch = findSingleKjvPhraseMatch(phrase)')
      || !background.includes('if (!hasBooleanOperators) await ensureKjvVerseCorpusLoaded();\n  const singleKjvMatch =')
      || !background.includes('if (normalizeKjvPassageWords(source).length >= 5) await ensureKjvVerseCorpusLoaded();')
      || !background.includes('const corpusRange = findKjvVerseRangeForSelection(source)')
      || !phraseIndexLoadsAfterRangeCheck
      || !background.includes('await ensureKjvVerseCorpusLoaded();\n    const singleMatch = findSingleKjvPhraseMatch(cleanedText)')) {
    fail('omnibox, selection classification, and direct-verse optimizations await corpus and phrase data only at their data-dependent decision points');
  } else {
    pass('omnibox, selection classification, and direct-verse optimizations defer corpus and phrase data until their decision points');
  }
  const lazyPhraseLoader = background.match(/async function ensureKjvPhraseIndexLoaded\(\) \{([\s\S]*?)\n\}/);
  if (!lazyPhraseLoader
      || !lazyPhraseLoader[1].includes('kjv-corpus-phrase-index.json.gz')
      || !lazyPhraseLoader[1].includes('fetchPackagedGzipJson(')
      || !lazyPhraseLoader[1].includes('Object.freeze(index)')
      || !lazyPhraseLoader[1].includes('kjvPhraseIndexLoadPromise')
      || !background.includes("new DecompressionStream('gzip')")) {
    fail('KJV phrase candidate index is fetched as data with a guarded, promise-deduplicated loader');
  } else {
    pass('KJV phrase candidate index has a guarded, promise-deduplicated data loader');
  }
  const gzipGenerator = read('scripts/generate-kjv-gzip-assets.cjs');
  const fixture = read('tests/browser/fixtures.js');
  const releaseScript = read('scripts/package-release.sh');
  if (!gzipGenerator.includes('gzipSync(')
      || !gzipGenerator.includes('kjv-corpus-verses.json.gz')
      || !gzipGenerator.includes('kjv-corpus-word-verse-index.json.gz')
      || !gzipGenerator.includes('kjv-corpus-phrase-index.json.gz')
      || !fixture.includes('generate-kjv-gzip-assets.cjs')
      || !releaseScript.includes('generate-kjv-gzip-assets.cjs')) {
    fail('compressed KJV data assets are generated from source data for browser tests and release packages');
  } else {
    pass('compressed KJV data assets are generated from source data for browser tests and release packages');
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
  const phraseIndexAwaitedAtDecisionPoint = background.includes('await ensureKjvPhraseIndexLoaded();')
    || background.includes('await Promise.all([ensureKjvVerseCorpusLoaded(), ensureKjvPhraseIndexLoaded()]);');
  if (!background.includes('await ensureKjvCaseSensitiveWordsLoaded();')
      || !background.includes('await ensureKjvOriginalCaseCorpusLoaded();')
      || !phraseIndexAwaitedAtDecisionPoint) {
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


const runtimeScriptReferences = new Set([
  'background.js',
  ...((manifest.content_scripts || []).flatMap(entry => entry.js || []))
]);
for (const htmlFile of ['extension/popup.html', 'extension/Tutorial.html', 'extension/multiverse-post.html']) {
  const html = read(htmlFile);
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+\.js)['"][^>]*>/gi)) {
    runtimeScriptReferences.add(match[1].replace(/^\.\//, ''));
  }
}
for (const match of background.matchAll(/['"]([^'"]+\.js)['"]/g)) {
  runtimeScriptReferences.add(match[1]);
}
const extensionJavaScriptFiles = [];
function collectExtensionJavaScript(directory, relative = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) collectExtensionJavaScript(absolute, name);
    else if (entry.isFile() && entry.name.endsWith('.js')) extensionJavaScriptFiles.push(name);
  }
}
collectExtensionJavaScript(ext);
const unreferencedExtensionScripts = extensionJavaScriptFiles.filter(file => !runtimeScriptReferences.has(file));
if (unreferencedExtensionScripts.length) {
  fail('every packaged extension JavaScript file has an explicit manifest, HTML, background-import, or runtime-injection reference: '
    + unreferencedExtensionScripts.join(', '));
} else {
  pass(extensionJavaScriptFiles.length + ' packaged extension JavaScript files are accounted for by runtime entry points');
}

let asyncTypes = [];
const asyncTypesMatch = background.match(/const ASYNC_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/);
if (!asyncTypesMatch) {
  fail('background asynchronous message allowlist remains discoverable for dispatch auditing');
} else {
  asyncTypes = [...asyncTypesMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  const dispatchSource = background.slice(asyncTypesMatch.index + asyncTypesMatch[0].length);
  const duplicateTypes = asyncTypes.filter((type, index) => asyncTypes.indexOf(type) !== index);
  if (duplicateTypes.length) {
    fail('asynchronous message allowlist entries are unique: ' + [...new Set(duplicateTypes)].join(', '));
  } else {
    pass(asyncTypes.length + ' asynchronous message allowlist entries are unique');
  }

  // A substring match is not enough: comments, diagnostics, or sender-side
  // strings can mention a message name without the background dispatching it.
  // Require an actual equality/inequality comparison against message.type.
  const dispatchedTypes = new Set(
    [...dispatchSource.matchAll(/message(?:\?\.|\.)type\s*(?:===|!==)\s*['"]([^'"]+)['"]/g)]
      .map(match => match[1])
  );
  const missingDispatch = asyncTypes.filter(type => !dispatchedTypes.has(type));
  if (missingDispatch.length) {
    fail('every asynchronous message allowlist entry has an explicit message.type dispatch comparison: '
      + missingDispatch.join(', '));
  } else {
    pass(asyncTypes.length + ' asynchronous message allowlist entries retain explicit dispatch comparisons');
  }
}


// Every asynchronous background message must have a real extension-side sender.
// Test-only entry points are listed explicitly so they cannot be mistaken for
// production callers, and their owning regression tests must continue to exist.
const testOnlyAsyncMessageTypes = new Map([
  ['blbSuiteClassifySelection', 'tests/browser/performance.spec.js'],
  ['blbSuiteOpenCurrentSelection', 'tests/browser/e2e-core-user-actions.spec.js']
]);
const runtimeMessageSources = extensionJavaScriptFiles
  .filter(file => file !== 'background.js')
  .map(file => ({ file, source: read(path.posix.join('extension', file)) }));
for (const [type, testFile] of testOnlyAsyncMessageTypes) {
  if (!asyncTypesMatch || !asyncTypes.includes(type)) {
    fail('test-only message exception remains in the background allowlist: ' + type);
  }
  if (!fs.existsSync(path.join(root, testFile)) || !read(testFile).includes(type)) {
    fail('test-only message exception retains its owning regression test: ' + type + ' -> ' + testFile);
  }
}
const unownedAsyncMessages = asyncTypes.filter(type => {
  if (testOnlyAsyncMessageTypes.has(type)) return false;
  const fragments = [
    "type:'" + type + "'",
    "type: '" + type + "'",
    'type:"' + type + '"',
    'type: "' + type + '"'
  ];
  return !runtimeMessageSources.some(({ source }) =>
    fragments.some(fragment => source.includes(fragment))
  );
});
if (unownedAsyncMessages.length) {
  fail('every asynchronous background message has an extension-side sender or an explicit test-only owner: '
    + unownedAsyncMessages.join(', '));
} else {
  pass(asyncTypes.length + ' asynchronous background messages have runtime senders or explicit test-only owners');
}


// Extension-page-only operations must be bound to the page that owns their
// UI/workflow. Content scripts share the extension ID, so sender.id alone is
// not an authorization boundary.
const extensionPageMessageSourcesMatch = background.match(
  /const EXTENSION_PAGE_MESSAGE_SOURCES = new Map\(\[([\s\S]*?)\]\);/
);
const extensionPageSourceFiles = new Map([
  ['popup.html', 'popup.js'],
  ['Tutorial.html', 'Tutorial.js'],
  ['multiverse-post.html', 'multiverse-post.js']
]);
const standaloneExtensionPageMessageConditions = new Map([
  ['blbSuiteMultiVerseHandoffTiming', "message?.type !== 'blbSuiteMultiVerseHandoffTiming'"],
  ['blbSuiteAcquireMultiVersePostSlot', "message?.type !== 'blbSuiteAcquireMultiVersePostSlot'"]
]);
if (!extensionPageMessageSourcesMatch) {
  fail('extension-page-only background messages declare their owning page');
} else {
  const entries = [...extensionPageMessageSourcesMatch[1].matchAll(
    /\[['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\]/g
  )].map(match => ({ type:match[1], page:match[2] }));
  const duplicateTypes = entries.filter((entry, index) =>
    entries.findIndex(candidate => candidate.type === entry.type) !== index
  );
  if (duplicateTypes.length) {
    fail('extension-page message ownership entries are unique: '
      + [...new Set(duplicateTypes.map(entry => entry.type))].join(', '));
  } else {
    pass(entries.length + ' extension-page-only messages have unique owning-page declarations');
  }
  let extensionPageOwnershipValid = true;
  for (const { type, page } of entries) {
    const standaloneCondition = standaloneExtensionPageMessageConditions.get(type);
    const hasDispatch = asyncTypes.includes(type) ||
      (standaloneCondition && background.includes(standaloneCondition));
    if (!hasDispatch) {
      fail('extension-page-only message has a registered background dispatch path: ' + type);
      extensionPageOwnershipValid = false;
      continue;
    }
    // Performance-only message sources are test-owned rather than emitted by
    // popup.js; their dedicated test-only contract above verifies that caller.
    if (testOnlyAsyncMessageTypes.has(type)) continue;
    const sourceFile = extensionPageSourceFiles.get(page);
    if (!sourceFile) {
      fail('extension-page-only message uses a known owning page: ' + type + ' -> ' + page);
      extensionPageOwnershipValid = false;
      continue;
    }
    const source = read(path.posix.join('extension', sourceFile));
    const fragments = [
      "type:'" + type + "'",
      "type: '" + type + "'",
      'type:"' + type + '"',
      'type: "' + type + '"'
    ];
    if (!fragments.some(fragment => source.includes(fragment))) {
      fail('owning extension page sends its declared message: ' + type + ' -> ' + sourceFile);
      extensionPageOwnershipValid = false;
    }
  }
  if (extensionPageOwnershipValid) {
    pass(entries.length + ' extension-page-only messages match their declared runtime sender files');
  }
}
const trustedPageHelper = background.match(
  /function isTrustedExtensionPageSender\(sender, expectedPagePath = ''\) \{([\s\S]*?)\n\}/
);
if (!trustedPageHelper ||
    !['sender.id', 'sender.url', 'chrome.runtime.getURL', 'senderUrl.origin', 'senderUrl.pathname']
      .every(fragment => trustedPageHelper[1].includes(fragment))) {
  fail('trusted extension-page sender validation checks extension identity, URL origin, and exact page path');
} else {
  pass('trusted extension-page sender validation checks extension identity, URL origin, and exact page path');
}


const authorizedContentSenderHelper = background.match(
  /async function isAuthorizedContentScriptSender\(sender, allowedHosts = null\) \{([\s\S]*?)\n\}/
);
if (!authorizedContentSenderHelper ||
    !['sender.id', 'sender.tab?.id', 'sender.url', 'hasSelectionActionPermissionForTab']
      .every(fragment => authorizedContentSenderHelper[1].includes(fragment))) {
  fail('content-script messages verify extension identity, tab context, and current host permission');
} else {
  pass('content-script messages verify extension identity, tab context, and current host permission');
}

const sourceCollectorSenderHelper = background.match(
  /function isSourceCollectorContentScriptSender\(sender\) \{([\s\S]*?)\n\}/
);
if (!sourceCollectorSenderHelper ||
    !sourceCollectorSenderHelper[1].includes('BLBSourcePageCollectorSites')) {
  fail('page-wide MultiVerse collection messages are restricted to registered collector hosts');
} else {
  pass('page-wide MultiVerse collection messages are restricted to registered collector hosts');
}

const contentSenderPolicyMessages = [
  ['blbSuiteOpenMultiVerseVerse', 'BLB_CONTENT_SCRIPT_HOSTS'],
  ['blbSuiteGetPendingMultiVerseRefs', 'BLB_CONTENT_SCRIPT_HOSTS'],
  ['blbSuiteConsumePendingMultiVerseRefs', 'BLB_CONTENT_SCRIPT_HOSTS'],
  ['blbSuiteStudyCaptureActive', 'BLB_AND_WEBSTER_CONTENT_SCRIPT_HOSTS'],
  ['blbSuiteCaptureStudyRefs', 'BLB_CONTENT_SCRIPT_HOSTS'],
  ['blbSuiteCaptureStudySearchTerm', 'BLB_AND_WEBSTER_CONTENT_SCRIPT_HOSTS'],
  ['blbSuiteCaptureStudyStrong', 'BLB_CONTENT_SCRIPT_HOSTS']
];
for (const [type, hostPolicy] of contentSenderPolicyMessages) {
  const branchStart = background.indexOf("if (message.type === '" + type + "')");
  const branchEnd = branchStart < 0 ? -1 : background.indexOf("\n  if (message.type ===", branchStart + 1);
  const branch = branchStart < 0 ? '' : background.slice(branchStart, branchEnd < 0 ? undefined : branchEnd);
  if (!branch.includes('isAuthorizedContentScriptSender(sender, ' + hostPolicy + ')')) {
    fail('content message ' + type + ' retains its expected source-host policy');
  }
}
if (contentSenderPolicyMessages.every(([type, hostPolicy]) => {
  const start = background.indexOf("if (message.type === '" + type + "')");
  const end = start < 0 ? -1 : background.indexOf("\n  if (message.type ===", start + 1);
  return start >= 0 && background.slice(start, end < 0 ? undefined : end)
    .includes('isAuthorizedContentScriptSender(sender, ' + hostPolicy + ')');
})) {
  pass(contentSenderPolicyMessages.length + ' BLB/Study content messages retain their expected source-host policies');
}
const genericContentSenderMessages = [
  'blbSuiteOpenWebsterMultiVerse',
  'blbSuiteSyncSelectionContextMenu',
  'blbSuiteOpenBackgroundUrl',
  'blbSuiteOpenBibleRefRange',
  'blbSuiteOpenScriptTaggerUrl'
];
for (const type of genericContentSenderMessages) {
  const start = background.indexOf("if (message.type === '" + type + "')");
  const end = start < 0 ? -1 : background.indexOf("\n  if (message.type ===", start + 1);
  const branch = start < 0 ? '' : background.slice(start, end < 0 ? undefined : end);
  if (!branch.includes('isAuthorizedContentScriptSender(sender)')) {
    fail('content message ' + type + ' verifies its current tab and host permission');
  }
}
if (genericContentSenderMessages.every(type => {
  const start = background.indexOf("if (message.type === '" + type + "')");
  const end = start < 0 ? -1 : background.indexOf("\n  if (message.type ===", start + 1);
  return start >= 0 && background.slice(start, end < 0 ? undefined : end)
    .includes('isAuthorizedContentScriptSender(sender)');
})) {
  pass(genericContentSenderMessages.length + ' generic content-script navigation/menu messages verify current host permission');
}
const websterMultiVerseBranch = background.slice(
  background.indexOf("if (message.type === 'blbSuiteOpenWebsterMultiVerse')"),
  background.indexOf("\n  if (message.type ===", background.indexOf("if (message.type === 'blbSuiteOpenWebsterMultiVerse')") + 1)
);
if (!websterMultiVerseBranch.includes('isSourceCollectorContentScriptSender(sender)')) {
  fail('page-wide MultiVerse collection messages verify a registered collector source');
} else {
  pass('page-wide MultiVerse collection messages verify a registered collector source');
}


const activeContentSenderHelper = background.match(
  /async function isActiveTabContentScriptSender\(sender\) \{([\s\S]*?)\n\}/
);
if (!activeContentSenderHelper ||
    !['isAuthorizedContentScriptSender(sender)', 'chrome.tabs.query({active:true, currentWindow:true})', 'tabs[0]?.id === sender.tab.id']
      .every(fragment => activeContentSenderHelper[1].includes(fragment))) {
  fail('selection handoff messages are restricted to the active authorized content tab');
} else {
  pass('selection handoff messages are restricted to the active authorized content tab');
}
const activeSelectionTypes = [
  'blbSuiteOpenCurrentSelection',
  'blbSuiteOpenSelectionText',
  'blbSuiteOpenDoubleClickSelectionText'
];
function activeSelectionBranchStart(type) {
  if (type === 'blbSuiteOpenDoubleClickSelectionText') {
    return background.indexOf("if (message.type === 'blbSuiteOpenSelectionText' || message.type === '" + type + "')");
  }
  return background.indexOf("if (message.type === '" + type + "'");
}
for (const type of activeSelectionTypes) {
  const start = activeSelectionBranchStart(type);
  const end = start < 0 ? -1 : background.indexOf("\n  if (message.type ===", start + 1);
  const branch = start < 0 ? '' : background.slice(start, end < 0 ? undefined : end);
  if (!branch.includes('isActiveTabContentScriptSender(sender)')) {
    fail('selection handoff message ' + type + ' is bound to its active sender tab');
  }
}
if (activeSelectionTypes.every(type => {
  const start = activeSelectionBranchStart(type);
  const end = start < 0 ? -1 : background.indexOf("\n  if (message.type ===", start + 1);
  return start >= 0 && background.slice(start, end < 0 ? undefined : end)
    .includes('isActiveTabContentScriptSender(sender)');
})) {
  pass(activeSelectionTypes.length + ' selection handoff message types are bound to the active sender tab');
}


const queueListenerStart = background.indexOf(
  "chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {",
  background.indexOf('function grantMultiVersePostSlot')
);
const queueListenerEnd = queueListenerStart < 0 ? -1 : background.indexOf("\n});", queueListenerStart);
const queueListener = queueListenerStart < 0 ? '' : background.slice(queueListenerStart, queueListenerEnd < 0 ? undefined : queueListenerEnd);
if (!queueListener.includes('const respondSafely = response =>') ||
    !queueListener.includes('try { sendResponse(response); } catch (_) {}') ||
    !queueListener.includes('error => respondSafely({ok:false, error:String(error)})')) {
  fail('MultiVerse queue replies safely handle success, rejection, and a closed sender channel');
} else {
  pass('MultiVerse queue replies safely handle success, rejection, and a closed sender channel');
}

if (failures.length) {
  for (const message of failures) console.error('FAIL:', message);
  process.exitCode = 1;
} else {
  console.log('All module-loading contract checks passed.');
}
