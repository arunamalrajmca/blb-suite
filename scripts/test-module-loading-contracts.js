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
  'source-bible-redirects.js',
  'source-site-click-redirects.js',
  'kings-bible-collector.js',
  'webster-collector.js',
  'source-page-collector.js',
  'selection-text.js',
  'double-click-reference-context.js',
  'double-click-context.js',
  'page-selection-classifier.js',
  'multiverse-button-drag.js',
  'page-selection-lifecycle.js',
  'multiverse-copy-links.js',
  'blb-auto-hyperlinker.js',
  'blb-parse-popup-links.js',
  'blb-navigation-links.js',
  'blb-new-tab-links.js',
  'blb-multiverse-handoff.js',
  'blb-passive-new-tab.js',
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

const doubleClickReferenceContext = read('extension/double-click-reference-context.js');
if (!doubleClickReferenceContext.includes('BLBDoubleClickReferenceContextModule')
    || !doubleClickReferenceContext.includes('resolveNearestChapterContext')
    || !doubleClickReferenceContext.includes('candidates.sort((a, b) => b.index - a.index)')) {
  fail('double-click nearest book/chapter context is isolated behind a pure module API');
} else {
  pass('double-click nearest book/chapter context remains isolated and nearest-match ordered');
}
if (!read('extension/double-click-context.js').includes('resolveNearestChapterContext(contextText)')) {
  fail('double-click context delegates nearest chapter resolution to the pure module');
} else {
  pass('double-click context delegates chapter matching to its pure module');
}

const sourceSiteClickRedirects = read('extension/source-site-click-redirects.js');
if (!sourceSiteClickRedirects.includes('BLBSourceSiteClickRedirectsModule')
    || !sourceSiteClickRedirects.includes('blbSuiteOpenWebsterMultiVerse')
    || !sourceSiteClickRedirects.includes('theKingsBibleLinkTarget')
    || !sourceSiteClickRedirects.includes('getCachedSuiteEnabled()')
    || !sourceSiteClickRedirects.includes('installChristianityLinkRedirect(() => getCachedSuiteEnabled() && isSourceRedirectEnabled())')) {
  fail('source-specific click redirect listeners are isolated behind an explicit module API');
} else {
  pass('source-specific click redirects retain explicit dependencies and master-setting gate');
}

const studySessionExport = read('extension/background-study-session-export.js');
if (!studySessionExport.includes('BLBBackgroundStudySessionExportModule')
    || !studySessionExport.includes('studySessionText')
    || !studySessionExport.includes('filterStudySessions')
    || !studySessionExport.includes('sortStudyRefs')) {
  fail('Study Session export formatting and filtering are isolated from Chrome I/O');
} else {
  pass('Study Session export formatting and filtering use an explicit pure-module contract');
}
if (!read('extension/background.js').includes('chrome.downloads.download({url, filename, saveAs:false}')) {
  fail('Study Session download side effect remains in the service worker');
} else {
  pass('Study Session download side effect remains in the service worker');
}

const studySessionStorage = read('extension/background-study-session-storage.js');
if (!studySessionStorage.includes('BLBBackgroundStudySessionStorageModule')
    || !studySessionStorage.includes('chrome.storage.local.get')
    || !studySessionStorage.includes('sanitizeStudySessions')) {
  fail('Study Session storage adapter owns sanitized read/write persistence');
} else {
  pass('Study Session storage adapter owns sanitized read/write persistence');
}
if (!read('extension/background.js').includes('chrome.alarms.onAlarm.addListener')) {
  fail('Study Session alarm event listener remains registered in background.js');
} else {
  pass('Study Session alarm event listener remains registered in background.js');
}

const background = read('extension/background.js');

const kjvSelectionNormalization = read('extension/background-kjv-selection-normalization.js');
if (!kjvSelectionNormalization.includes('BLBBackgroundKjvSelectionNormalizationModule')
    || !kjvSelectionNormalization.includes('isKjvVocabularySelection')
    || !kjvSelectionNormalization.includes('selectionContainsBibleBookName')
    || !kjvSelectionNormalization.includes('KJV_CITED_VERSE_MIN_EXCLUSION_WORDS')
    || !kjvSelectionNormalization.includes('kjvPassageQueryCache')) {
  fail('KJV selection normalization and passage-cache policy are isolated behind a module API');
} else {
  pass('KJV selection normalization and vocabulary/book-name checks remain together');
}
if (!background.includes('BLBBackgroundKjvSelectionNormalizationModule.create({')
    || !background.includes('kjvWordIndex:KJV_CORPUS_WORD_INDEX')
    || !background.includes('const { normalizeSelectedScriptureText')) {
  fail('background initializes KJV selection normalization before downstream passage matching');
} else {
  pass('KJV selection normalization is initialized before downstream passage matching');
}

const content = read('extension/content.js');
const importMatch = background.match(/^\s*importScripts\(([^;]+)\);/);
if (!importMatch) {
  fail('background service worker begins with its classic importScripts bootstrap');
} else {
  const imports = [...importMatch[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map(match => match[1]);
  const required = [
    'regex-patterns.js',
    'kjv-corpus-word-index.js',
    'kjv-corpus-word-verse-index.js',
    'kjv-corpus-verses.js',
    'kjv-corpus-phrase-index.js',
    'kjv-corpus-original-case.js',
    'kjv-case-sensitive-words.js',
    'case-sensitive-search-core.js',
    'case-sensitive-routing.js',
    'kjv-corpus-case-verse-index.js',
    'books.js',
    'book-aliases.js',
    'reference-core.js',
    'background-host-policy.js',
    'background-content-script-registry.js',
    'background-content-script-activation.js',
    'background-multiverse-tracking.js',
    'background-blb-destination-manager.js',
    'background-study-session-model.js',
  'background-study-session-storage.js',
  'background-study-session-export.js',
    'background-study-pdf-export.js',
    'background-omnibox-search.js',
    'background-bible-input.js',
    'background-pdf-reference-extractor.js',
    'background-selection-context-menu.js',
    'background-kjv-selection-normalization.js'
  ];
  const positions = required.map(name => imports.indexOf(name));
  if (positions.some(index => index < 0)
      || positions.some((index, i) => i > 0 && index <= positions[i - 1])) {
    fail('service-worker imports retain dependency order: ' + required.join(' -> '));
  } else {
    pass('service-worker import dependency order remains stable');
  }
  if (background.indexOf('importScripts(') !== background.lastIndexOf('importScripts(')) {
    fail('service-worker bootstrap has a single top-level importScripts call');
  } else {
    pass('service-worker bootstrap importScripts call remains singular');
  }
}

const hostPolicy = read('extension/background-host-policy.js');
const dynamicFilesMatch = hostPolicy.match(/const contentScriptFiles = \[([\s\S]*?)\];/);
if (!dynamicFilesMatch) {
  fail('runtime-injected content scripts declare their dependency list in host policy');
} else {
  const dynamicFiles = [...dynamicFilesMatch[1].matchAll(/['\"]([^'\"]+\.js)['\"]/g)].map(match => match[1]);
  const requiredDynamic = ['reference-core.js', 'kings-bible-collector.js', 'webster-collector.js', 'source-page-collector.js', 'selection-text.js', 'double-click-context.js', 'page-selection-classifier.js', 'multiverse-button-drag.js', 'page-selection-lifecycle.js', 'multiverse-copy-links.js', 'blb-auto-hyperlinker.js', 'blb-parse-popup-links.js', 'blb-navigation-links.js', 'blb-new-tab-links.js', 'blb-multiverse-handoff.js', 'blb-passive-new-tab.js', 'content.js'];
  const positions = requiredDynamic.map(name => dynamicFiles.indexOf(name));
  if (positions.some(index => index < 0)
      || positions.some((index, i) => i > 0 && index <= positions[i - 1])) {
    fail('runtime-injected content scripts retain shared-core and feature module order: '
      + requiredDynamic.join(' -> '));
  } else {
    pass('runtime-injected content scripts retain feature module dependency order');
  }
}


const multiverseTracking = read('extension/background-multiverse-tracking.js');
if (!multiverseTracking.includes('BLBBackgroundMultiVerseTrackingModule')
    || !multiverseTracking.includes('pendingUpdate')
    || !multiverseTracking.includes('canonicalMultiVerseSet')
    || !multiverseTracking.includes('blbSuiteMultiVerseTabSets')
    || !multiverseTracking.includes('expandMultiVerseRefsToVerses')
    || !multiverseTracking.includes('compactMultiVerseVerses')
    || !multiverseTracking.includes('maxVerses = 200')
    || /chrome(?:Api)?\.(?:tabs|runtime|alarms|contextMenus)\.[A-Za-z]+\.addListener/.test(multiverseTracking)) {
  fail('MultiVerse tracking is isolated without moving service-worker event listeners');
} else {
  pass('MultiVerse tracking module owns canonicalization and serialized storage only');
}
if (!background.includes('BLBBackgroundMultiVerseTrackingModule.create({')
    || !background.includes('chromeApi:chrome')
    || !background.includes('canonicalStoredRef')) {
  fail('service worker initializes tracking module with explicit dependencies');
} else {
  pass('service-worker tracking module receives explicit dependencies');
}


const destinationManager = read('extension/background-blb-destination-manager.js');
if (!destinationManager.includes('BLBBackgroundBlbDestinationManagerModule')
    || !destinationManager.includes('pendingBlbDestinationOperations')
    || !destinationManager.includes('findExisting')
    || !destinationManager.includes('create')) {
  fail('BLB destination identity locking is isolated behind its module API');
} else {
  pass('BLB destination identity manager retains single-owner operation locking');
}
if (!background.includes('BLBBackgroundBlbDestinationManagerModule.create({')
    || !background.includes('chromeApi:chrome')) {
  fail('service worker initializes destination manager with explicit Chrome API');
} else {
  pass('service-worker destination manager receives explicit Chrome API');
}
if (!background.includes('chrome.tabs.onRemoved.addListener(')
    || !background.includes('chrome.tabs.onUpdated.addListener(')
    || !background.includes('chrome.runtime.onInstalled.addListener(')
    || !background.includes('chrome.alarms.onAlarm.addListener(')) {
  fail('service-worker event listeners remain registered in background.js');
} else {
  pass('service-worker lifecycle and event listeners remain in background.js');
}


const studyModel = read('extension/background-study-session-model.js');
if (!studyModel.includes('BLBBackgroundStudySessionModelModule')
    || !studyModel.includes('sanitizeStudySessions')
    || !studyModel.includes('canonicalStoredRef')
    || !studyModel.includes('titleCaseStudyNote')
    || /chrome(?:Api)?\.(?:tabs|runtime|alarms|contextMenus)\.[A-Za-z]+\.addListener/.test(studyModel)) {
  fail('study-session model is isolated from storage and service-worker event registration');
} else {
  pass('study-session canonicalization and cleanup remain in a pure model module');
}
if (!background.includes('BLBBackgroundStudySessionModelModule.create({')
    || !background.includes('bookAliases:BOOK_ALIASES')
    || !background.includes('const { studyDateInfo, createStudySession')) {
  fail('service worker initializes the study model before storage operations');
} else {
  pass('study-session model is initialized before dependent storage operations');
}


const studyPdf = read('extension/background-study-pdf-export.js');
if (!studyPdf.includes('BLBStudyPdfExportModule')
    || !studyPdf.includes('buildStudySessionsPdf')
    || !studyPdf.includes('startxref')
    || !studyPdf.includes('studyBookDisplayName')
    || /chrome(?:Api)?\.(?:tabs|runtime|alarms|contextMenus)\.[A-Za-z]+\.addListener/.test(studyPdf)) {
  fail('Study Session PDF formatting and serialization are isolated from service-worker listeners');
} else {
  pass('Study Session PDF formatter remains a self-contained module');
}
if (!background.includes('BLBStudyPdfExportModule.create({studyBookDisplayName})')
    || !background.includes('function buildStudySessionsPdf(content, options = {})')) {
  fail('background initializes the PDF formatter and preserves the existing call contract');
} else {
  pass('Study Session PDF module initialization and call contract remain stable');
}


const doubleClickContext = read('extension/double-click-context.js');
if (!doubleClickContext.includes('BLBDoubleClickContextModule')
    || !doubleClickContext.includes('getDoubleClickBlockContextReference')
    || !doubleClickContext.includes('resolveBibleReferenceFromContextWindow')
    || !doubleClickContext.includes('caretRangeFromPoint')
    || /chrome(?:Api)?\.(?:tabs|runtime|alarms|contextMenus)\.[A-Za-z]+\.addListener/.test(doubleClickContext)) {
  fail('Double-click reference-context logic is isolated from event listeners');
} else {
  pass('Double-click context module retains positional and block-local reference resolution');
}
if (!content.includes('BLBDoubleClickContextModule.create({')
    || !content.includes('NodeCtor:Node')
    || !content.includes('validateSourceBibleReference')
    || !content.includes('getDoubleClickTargetElement')
    || !content.includes('resolveBibleReferenceText')
    || !content.includes('resolveBibleReference')) {
  fail('content script initializes the context module with explicit DOM and reference dependencies');
} else {
  pass('double-click context module receives explicit DOM and reference dependencies');
}


const bibleInput = read('extension/background-bible-input.js');
if (!bibleInput.includes('BLBBackgroundBibleInputModule')
    || !bibleInput.includes('parseInput')
    || !bibleInput.includes('findBestBookMatch')
    || !bibleInput.includes('parseSearchInputForFallback')
    || !bibleInput.includes('isObviouslyGibberishQuery')
    || /chrome(?:Api)?\.(?:tabs|runtime|alarms|contextMenus)\.[A-Za-z]+\.addListener/.test(bibleInput)) {
  fail('Bible-input parsing is isolated from tab side effects and service-worker listeners');
} else {
  pass('Bible-input parser and fallback-search normalization remain in a pure module');
}
if (!background.includes('BLBBackgroundBibleInputModule.create({')
    || !background.includes('normalizeBooleanOperatorsOutsideQuotes')) {
  fail('background initializes Bible-input parsing with explicit shared dependencies');
} else {
  pass('Bible-input module receives explicit parser dependencies');
}


const pdfReferenceExtractor = read('extension/background-pdf-reference-extractor.js');
if (!pdfReferenceExtractor.includes('BLBBackgroundPdfReferenceExtractorModule')
    || !pdfReferenceExtractor.includes('extractBibleRefsFromSelectedTextUncached')
    || !pdfReferenceExtractor.includes('crossChapterRangeRe')
    || !pdfReferenceExtractor.includes('sameBookClauseRe')
    || !pdfReferenceExtractor.includes('resolveBibleReference')) {
  fail('PDF/selection Bible-reference extraction is isolated behind explicit resolver dependencies');
} else {
  pass('PDF/selection reference extractor retains chapter-range and continuation parsing');
}
if (!background.includes('BLBBackgroundPdfReferenceExtractorModule.create({')
    || !background.includes('getBibleBookForms')
    || !background.includes('resolveBibleReference')) {
  fail('service worker initializes the PDF reference extractor with shared book/reference APIs');
} else {
  pass('PDF reference extractor receives explicit shared resolver dependencies');
}


const pageSelectionClassifier = read('extension/page-selection-classifier.js');
if (!pageSelectionClassifier.includes('BLBPageSelectionClassifierModule')
    || !pageSelectionClassifier.includes('hasLocalValidBibleReference')
    || !pageSelectionClassifier.includes('canonicalStrongValue')
    || !pageSelectionClassifier.includes('resolveBibleReference')
    || /chrome(?:Api)?\.(?:tabs|runtime|alarms|contextMenus)\.[A-Za-z]+\.addListener/.test(pageSelectionClassifier)) {
  fail('page-selection classification is isolated from UI and event lifecycle');
} else {
  pass('page-selection classifier retains local Bible-reference and Strong’s checks');
}
if (!content.includes('BLBPageSelectionClassifierModule.create({')
    || !content.includes('bookAliases:BOOK_ALIASES')
    || !content.includes('canonicalStrongValue')) {
  fail('content initializes page-selection classifier with explicit resolver dependencies');
} else {
  pass('page-selection classifier receives explicit reference dependencies');
}


const selectionContextMenu = read('extension/background-selection-context-menu.js');
if (!selectionContextMenu.includes('BLBBackgroundSelectionContextMenuModule')
    || !selectionContextMenu.includes('syncWebSelectionContextMenuVisibility')
    || !selectionContextMenu.includes('syncPdfSelectionContextMenuVisibility')
    || !selectionContextMenu.includes('selectionMenuOperation')
    || /chrome(?:Api)?\.(?:tabs|runtime|alarms|contextMenus)\.[A-Za-z]+\.addListener/.test(selectionContextMenu)) {
  fail('selection context-menu policy and state are isolated without owning service-worker listeners');
} else {
  pass('selection context-menu module owns visibility policy while leaving listener registration outside');
}
if (!background.includes('chrome.tabs.onActivated.addListener(')
    || !background.includes('chrome.tabs.onUpdated.addListener(')
    || !background.includes('chrome.contextMenus.onClicked.addListener(')
    || !background.includes('BLBBackgroundSelectionContextMenuModule.create({')) {
  fail('service-worker tab/context-menu listeners remain registered after module initialization');
} else {
  pass('service-worker tab and context-menu listener registration remains in background.js');
}


const pageSelectionLifecycle = read('extension/page-selection-lifecycle.js');
if (!pageSelectionLifecycle.includes('BLBPageSelectionLifecycleModule')
    || !pageSelectionLifecycle.includes('validateBlbPageSelectionAfterDomMutation')
    || !pageSelectionLifecycle.includes('enableBlbPageButtonMonitoring')
    || !pageSelectionLifecycle.includes('disableBlbPageButtonMonitoring')
    || !pageSelectionLifecycle.includes('state.pageButtonMonitoring')
    || /chrome\.runtime\.onMessage\.addListener/.test(pageSelectionLifecycle)) {
  fail('floating page-selection lifecycle is isolated without moving the runtime message listener');
} else {
  pass('floating page-selection lifecycle preserves shared state and DOM invalidation');
}
if (!content.includes('BLBPageSelectionLifecycleModule.create({')
    || !content.includes('Object.defineProperties(BLBPageSelectionState')
    || !content.includes('chrome.runtime.onMessage.addListener(')) {
  fail('content script initializes lifecycle state and retains its runtime message listener');
} else {
  pass('content script bridges live lifecycle state and retains message-listener ordering');
}


const omniboxSearch = read('extension/background-omnibox-search.js');
if (!omniboxSearch.includes('BLBBackgroundOmniboxSearchModule')
    || !omniboxSearch.includes('normalizeBooleanOperatorsOutsideQuotes')
    || !omniboxSearch.includes('findSingleKjvPhraseMatch')
    || !omniboxSearch.includes('findSingleKjvWordIntersectionMatch')
    || !omniboxSearch.includes('KJV_CORPUS_WORD_VERSE_INDEX')) {
  fail('Omnibox exact-match and boolean normalization helpers are isolated behind a module API');
} else {
  pass('Omnibox query normalization and exact-match search helpers remain together');
}
if (!background.includes('BLBBackgroundOmniboxSearchModule.create({')
    || !background.includes('normalizeBooleanOperatorsOutsideQuotes')
    || !background.includes('background-omnibox-search.js')) {
  fail('background initializes omnibox helpers before dependent Bible-input parsing');
} else {
  pass('Omnibox module initialization precedes dependent Bible-input parser');
}


const sourceRedirects = read('extension/source-bible-redirects.js');
if (!sourceRedirects.includes('BLBSourceBibleRedirectModule')
    || !sourceRedirects.includes('function redirectBibleSite')
    || !sourceRedirects.includes('function redirectBlbNet')
    || !sourceRedirects.includes('parseChristianityBibleLink')
    || /addEventListener\(['"](?:click|dblclick|mousedown|mouseup)/.test(sourceRedirects)) {
  fail('Bible-site URL parsing and redirect decisions are isolated from DOM click listeners');
} else {
  pass('Bible-site redirect module owns parsers and page-load decisions only');
}
if (!content.includes('BLBSourceBibleRedirectModule.create({')
    || !content.includes('openBlbDestinationFromContent')) {
  fail('content initializes source redirects with explicit destination opener');
} else {
  pass('source redirect module receives the destination opener explicitly');
}

const dragModule = read('extension/multiverse-button-drag.js');
if (!dragModule.includes('BLBMultiVerseButtonDragModule')
    || !dragModule.includes('pointerdown')
    || !dragModule.includes('pointermove')
    || !dragModule.includes('Reset button position')
    || !dragModule.includes('positionWriteQueue')) {
  fail('MultiVerse drag/position behavior is isolated behind its feature-module API');
} else {
  pass('MultiVerse drag/position behavior retains pointer and reset safeguards');
}
if (!content.includes('BLBMultiVerseButtonDragModule.create({')
    || !content.includes('MutationObserverCtor:MutationObserver')) {
  fail('content script initializes drag module with explicit browser dependencies');
} else {
  pass('MultiVerse drag module receives explicit browser dependencies');
}

const selectionText = read('extension/selection-text.js');
if (!selectionText.includes('BLBSelectionTextModule')
    || !selectionText.includes('normalize(value)')
    || !selectionText.includes('normalizeKey(value)')
    || /\\b(?:document|window)\\s*\\./.test(selectionText)) {
  fail('selection-text normalization is isolated behind a DOM-free feature-module API');
} else {
  pass('selection-text normalization remains isolated and DOM-free');
}
if (!content.includes('BLBSelectionTextModule.normalize(value)')
    || !content.includes('BLBSelectionTextModule.normalizeKey(value)')) {
  fail('content script delegates selection normalization to the feature module');
} else {
  pass('content script delegates selection normalization to the feature module');
}

const copyModule = read('extension/multiverse-copy-links.js');
if (!copyModule.includes('BLBMultiVerseCopyLinksModule')
    || !copyModule.includes('nativeMultiVerseCopyPending')
    || !copyModule.includes('#copyButton, #copyByVerseButton')) {
  fail('MultiVerse copy enhancement is isolated behind its feature-module API');
} else {
  pass('MultiVerse copy enhancement module retains native-copy gating');
}
if (!content.includes('BLBMultiVerseCopyLinksModule?.initialize({')
    || !content.includes('isSuiteEnabled: () => suiteEnabled')) {
  fail('content script initializes MultiVerse copy enhancement with live suite state');
} else {
  pass('MultiVerse copy enhancement receives live suite state');
}

const autoHyperlinker = read('extension/blb-auto-hyperlinker.js');
if (!autoHyperlinker.includes('BLBAutoHyperlinkModule')
    || !autoHyperlinker.includes('format(rawText, blbHomeUrl)')
    || !autoHyperlinker.includes('initialize({ isSuiteEnabled, getCachedEnabled, blbHostname, blbHomeUrl })')
    || !autoHyperlinker.includes('text-decoration:underline')) {
  fail('BLB auto-hyperlink formatter is isolated behind its feature-module API');
} else {
  pass('BLB auto-hyperlink formatter retains its HTML-link contract');
}
if (!content.includes('BLBAutoHyperlinkModule?.initialize({')
    || !autoHyperlinker.includes('document.addEventListener("copy"')) {
  fail('content script initializes the extracted BLB copy-link feature module');
} else {
  pass('BLB copy-link event lifecycle is owned by its feature module');
}

const parsePopupModule = read('extension/blb-parse-popup-links.js');
if (!parsePopupModule.includes('BLBParsePopupLinksModule')
    || !parsePopupModule.includes('link.closest?.(".parse-popup")')
    || !parsePopupModule.includes('stopImmediatePropagation()')) {
  fail('BLB parse-popup interception remains scoped in its feature module');
} else {
  pass('BLB parse-popup interception remains scoped in its feature module');
}
if (!content.includes('BLBParsePopupLinksModule?.initialize({')) {
  fail('content script initializes the parse-popup feature module');
} else {
  pass('content script initializes the parse-popup feature module');
}

const passiveNewTab = read('extension/blb-passive-new-tab.js');
if (!passiveNewTab.includes('BLBPassiveNewTabModule')
    || !passiveNewTab.includes('MutationObserver')
    || !passiveNewTab.includes('requestAnimationFrame')
    || !passiveNewTab.includes('link.target="_blank"')) {
  fail('passive BLB new-tab targeting remains in its feature module');
} else {
  pass('passive BLB new-tab targeting remains in its feature module');
}
if (!content.includes('BLBPassiveNewTabModule?.initialize({')) {
  fail('content script initializes passive new-tab targeting');
} else {
  pass('content script initializes passive new-tab targeting');
}

const navigationLinks = read('extension/blb-navigation-links.js');
if (!navigationLinks.includes('BLBNavigationLinksModule')
    || !navigationLinks.includes('blbSuiteOpenMultiVerseVerse')
    || !navigationLinks.includes('Criteria Search ordinary verse links')
    || !navigationLinks.includes('stopImmediatePropagation()')) {
  fail('MultiVerse and Criteria Search navigation handlers remain in their feature module');
} else {
  pass('MultiVerse and Criteria Search navigation handlers remain in their feature module');
}
if (!content.includes('BLBNavigationLinksModule?.initialize({')) {
  fail('content script initializes the BLB navigation feature module');
} else {
  pass('content script initializes the BLB navigation feature module');
}

const newTabLinks = read('extension/blb-new-tab-links.js');
if (!newTabLinks.includes('BLBNewTabLinksModule')
    || !newTabLinks.includes('a.nowrap')
    || !newTabLinks.includes('stopImmediatePropagation()')
    || !newTabLinks.includes('requestAnimationFrame')) {
  fail('normal BLB new-tab and native-link handoff remains in its feature module');
} else {
  pass('normal BLB new-tab and native-link handoff remains in its feature module');
}
if (!content.includes('BLBNewTabLinksModule?.initialize({')) {
  fail('content script initializes normal BLB new-tab feature module');
} else {
  pass('content script initializes normal BLB new-tab feature module');
}

const multiverseHandoff = read('extension/blb-multiverse-handoff.js');
if (!multiverseHandoff.includes('BLBMultiVerseHandoffModule')
    || !multiverseHandoff.includes('blbSuiteGetPendingMultiVerseRefs')
    || !multiverseHandoff.includes('blbSuiteCaptureStudyRefs')
    || !multiverseHandoff.includes('revealPendingMultiVerseView')) {
  fail('MultiVerse hand-off and study capture remain in their feature module');
} else {
  pass('MultiVerse hand-off and study capture remain in their feature module');
}
if (!content.includes('BLBMultiVerseHandoffModule?.initialize({')) {
  fail('content script initializes the MultiVerse hand-off feature module');
} else {
  pass('content script initializes the MultiVerse hand-off feature module');
}

const hostPolicy = read('extension/background-host-policy.js');
if (!hostPolicy.includes('BLBBackgroundHostPolicyModule')
    || !hostPolicy.includes('contentScriptFilesForTab(tab, data')
    || !hostPolicy.includes('isSensitiveSiteHostname(hostname)')) {
  fail('background host and injection policy is isolated behind its module API');
} else {
  pass('background host and injection policy is isolated behind its module API');
}
if (!background.includes('BLB_BACKGROUND_HOST_POLICY.contentScriptFilesForTab(tab, data')) {
  fail('background service worker delegates tab injection policy to the module');
} else {
  pass('background service worker delegates tab injection policy to the module');
}

if (!hostPolicy.includes('originPatternForUrl(url)')
    || !hostPolicy.includes('hasHostAccessForTab(tab, chromeApi)')
    || !background.includes('BLB_BACKGROUND_HOST_POLICY.hasHostAccessForTab(tab, chrome)')) {
  fail('host permission and URL-pattern checks remain behind the background policy module');
} else {
  pass('host permission and URL-pattern checks remain behind the background policy module');
}

const registry = read('extension/background-content-script-registry.js');
if (!registry.includes('BLBBackgroundContentScriptRegistryModule')
    || !registry.includes('ensureRuntimeContentScriptRegistered')
    || !registry.includes('unregisterRuntimeContentScriptForPattern')
    || !background.includes('BLB_BACKGROUND_SCRIPT_REGISTRY.ensureRuntimeContentScriptRegistered')) {
  fail('runtime content-script registration is isolated behind its registry module');
} else {
  pass('runtime content-script registration is isolated behind its registry module');
}

const activation = read('extension/background-content-script-activation.js');
if (!activation.includes('BLBBackgroundContentScriptActivationModule')
    || !activation.includes('contentScriptInjectionLocks')
    || !activation.includes('blbSuiteRefreshSiteFeatures')
    || !background.includes('BLB_BACKGROUND_CONTENT_SCRIPT_ACTIVATION.ensureContentScriptInTab')) {
  fail('per-tab content-script activation remains isolated behind its module API');
} else {
  pass('per-tab content-script activation remains isolated behind its module API');
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
