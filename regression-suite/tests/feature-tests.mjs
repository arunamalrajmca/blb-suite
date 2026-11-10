export function registerFeatureSearchTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
section('features');
// Case-sensitive core + corpus.
const csCtx = loadPure(['case-sensitive-search-core.js','kjv-corpus-original-case.js','kjv-corpus-case-verse-index.js']);
const omniboxCtx = loadPure(['books.js','kjv-corpus-verses.js','kjv-corpus-word-verse-index.js']);
vm.runInContext(read('omnibox-search-helpers.js'), omniboxCtx, {filename:'omnibox-search-helpers.js'});
const omniboxBgSource = read('background.js');
const omniboxHelperStart = omniboxBgSource.indexOf('function normalizeOmniboxSearchPhrase');
const omniboxHelperEnd = omniboxBgSource.indexOf('\nasync function handleBCommand', omniboxHelperStart);
if (omniboxHelperStart >= 0 && omniboxHelperEnd > omniboxHelperStart) {
  vm.runInContext(omniboxBgSource.slice(omniboxHelperStart, omniboxHelperEnd), omniboxCtx, {filename:'background.js:omnibox-search-helpers'});
}
test('normal b single-result phrase resolves directly to its verse', () => {
  const match = omniboxCtx.findSingleKjvPhraseMatch('"adoption to wit"');
  assert(match, 'expected unique KJV phrase result');
  assert.deepEqual([Number(match[0]), Number(match[1]), Number(match[2])], [45, 8, 23]);
  assert.equal(omniboxCtx.findSingleKjvPhraseMatch('Jesus'), null, 'multiple results must retain native search');
});
test('quoted normal b single-result path checks direct verse before native quoted search', () => {
  const start = omniboxBgSource.indexOf('const quotedMatch = t.match');
  const end = omniboxBgSource.indexOf('\n  if (low.endsWith("."))', start);
  assert(start >= 0 && end > start, 'quoted b handler block missing');
  const quotedBlock = omniboxBgSource.slice(start, end);
  assert(quotedBlock.includes('const singleMatch = findSingleKjvPhraseMatch(phrase)'), 'quoted path must use single-result resolver');
  assert(quotedBlock.includes("await openSingleKjvVerse(singleMatch, 'currentTab')"), 'quoted single-result path must open the verse directly');
  assert(quotedBlock.includes('chrome.tabs.update({url:'), 'quoted fallback must retain native search');
});
test('b cs single-result phrase resolves directly while multi-result remains MultiVerse', () => {
  const one = csCtx.BLBCaseSensitiveCore.searchCaseSensitiveCorpus('adoption to wit', csCtx.KJV_CORPUS_ORIGINAL_CASE, csCtx.KJV_CORPUS_CASE_VERSE_INDEX);
  assert.equal(one.length, 1);
  assert(omniboxBgSource.includes('if (refs.length === 1)'), 'case-sensitive single-result direct-verse branch missing');
  assert(omniboxBgSource.includes('openSingleKjvVerse([refs[0].bookNumber, refs[0].chapter, refs[0].verse], disposition)'), 'case-sensitive direct-verse opener missing');
});

test('case-sensitive parser preserves raw query', () => {
  const p=csCtx.BLBCaseSensitiveCore.parseCaseSensitiveQuery('b cs "JESUS"');
  // The parser intentionally expects the text after `cs` in this layer.
  assert.equal(p, null);
  const q=csCtx.BLBCaseSensitiveCore.parseCaseSensitiveQuery('cs "JESUS"');
  assert.equal(q.rawQuery,'"JESUS"');
  assert.equal(q.query,'JESUS');
});
test('exact-case corpus search finds JESUS', () => {
  const matches=csCtx.BLBCaseSensitiveCore.searchCaseSensitiveCorpus('Jesus', csCtx.KJV_CORPUS_ORIGINAL_CASE, csCtx.KJV_CORPUS_CASE_VERSE_INDEX);
  assert.equal(matches.length, 929, 'baseline corpus should contain 929 exact-case Jesus matches');
});
test('scrambled-case detection', () => {
  // Load routing separately because it expects the generated Set.
  const routingCtx = loadPure(['kjv-case-sensitive-words.js','case-sensitive-routing.js']);
  assert.equal(routingCtx.hasScrambledCase('jEsUs'), true);
  assert.equal(routingCtx.hasScrambledCase('Jesus'), false);
  assert.equal(routingCtx.hasScrambledCase('JESUS'), false);
});

section('features');
// Static cross-file contracts for high-risk regressions.

}

export function registerFeatureIntegrationTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
section('features');
test('Webster 1828 path remains wired', () => {
  const content = read('content.js'), webster = read('webster-collector.js'), bg = read('background.js');
  assert(read('source-page-collector-sites.js').includes('"webstersdictionary1828.com"'), 'Webster host missing from the shared collector registry');
  assert(webster.includes('websterCollectorConfig?.collectorModule === "webster"'), 'Webster collector must use shared registry metadata');
  assert(webster.includes('collectWebsterBibleRefs'), 'Webster collector missing');
  assert(webster.includes('blbSuiteOpenBackgroundUrl'), 'Webster opener missing');
  assert(content.includes('BLBWebsterCollectorModule') && content.includes('BLBWebsterCollector'), 'Webster module initialization and master-setting refresh hook missing');
  assert(bg.includes('blbSuiteOpenWebsterMultiVerse'), 'Webster MultiVerse handler missing');
});
test('MultiVerse native-copy enhancement remains wired', () => {
  const content = read('content.js'), copyModule = read('multiverse-copy.js');
  const manifest = JSON.parse(read('manifest.json')), bg = read('background.js');
  assert(content.includes('BLBMultiVerseCopyModule?.initialize'), 'content script does not initialize MultiVerse copy module');
  assert(copyModule.includes('#copyButton, #copyByVerseButton'), 'native Copy buttons are not targeted');
  assert(copyModule.includes('nativeMultiVerseCopyPending'), 'copy enhancement is not gated to BLB native Copy-button clicks');
  assert(copyModule.includes('"text/html"'), 'HTML clipboard payload is missing');
  const entry = (manifest.content_scripts || []).find(item => (item.js || []).includes('content.js'));
  assert(entry && entry.js.indexOf('multiverse-copy.js') < entry.js.indexOf('content.js'), 'manifest must load MultiVerse copy module before content.js');
  assert(bg.includes("'multiverse-copy.js'"), 'runtime injection list must include MultiVerse copy module');
});
test('Source-page Bible-reference collector remains wired', () => {
  const content = read('content.js'), collector = read('source-page-collector.js');
  const registry = read('source-page-collector-sites.js');
  const manifest = JSON.parse(read('manifest.json')), bg = read('background.js');
  for (const host of ['christianity.com', 'gotquestions.org', 'crosswalk.com', 'enduringword.com', 'rediscover.bible', 'sagacityweb.com', 'thetreasuryofscriptureknowledge.com', 'dailyverses.net', 'churchofjesuschrist.org', 'mercyhouseministry.com', 'openbible.info', 'crossway.org', 'sarata.com', 'sermonindex.net', 'thekingsbible.com', 'webstersdictionary1828.com']) {
    assert(registry.includes(host), `source-page collector registry missing host: ${host}`);
  }
  assert(collector.includes('BLBSourcePageCollectorSites?.[host]'), 'source-page collector does not use the shared host registry');
  assert(content.includes('BLBSourcePageCollectorModule?.initialize'), 'content script does not initialize the source-page collector');
  assert(collector.includes('collectSourcePageBibleReferences'), 'source-page reference collector missing');
  assert(collector.includes('blbSuiteOpenWebsterMultiVerse'), 'source-page MultiVerse opener missing');
  const entry = (manifest.content_scripts || []).find(item => (item.js || []).includes('content.js'));
  assert(entry && entry.js.indexOf('source-page-collector-sites.js') < entry.js.indexOf('source-page-collector.js') && entry.js.indexOf('source-page-collector.js') < entry.js.indexOf('content.js'), 'manifest must load the shared site registry and collector before content.js');
  assert(bg.includes("'source-page-collector-sites.js'") && bg.includes("'source-page-collector.js'"), 'runtime injection list must load the shared registry before the source-page collector');
});

}

export function registerStudySessionTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
section('features');
test('Study Sessions command surface remains wired', () => {
  const bg = read('background.js'), popup = read('popup.js');
  for (const type of ['blbSuiteStartStudyTopic','blbSuiteStopStudyRecording','blbSuiteAddStudyNoteToTopic','blbSuiteUpdateStudyNoteToTopic','blbSuiteStudyTopicHistory','blbSuiteStudyTopicMultiVerse','blbSuiteOpenStrongHistory','blbSuiteOpenHistorySearchTerms']) {
    assert(bg.includes(type), `background Study Sessions handler missing: ${type}`);
    assert(popup.includes(type), `popup Study Sessions caller missing: ${type}`);
  }
});
test('Study Sessions download paths remain wired', () => {
  const bg = read('background.js'), popup = read('popup.js');
  for (const type of ['blbSuiteDownloadStudyTopic','blbSuiteDownloadStudyWhole','blbSuiteDownloadStudyDate']) {
    assert(bg.includes(type), `download handler missing: ${type}`);
    assert(popup.includes(type), `download caller missing: ${type}`);
  }
});
test('b dict routes bare, multiword, and invalid input home; one alphabetic word to Webster entry', () => {
  const bg = read('background.js');
  const start = bg.indexOf('const dictMatch = normalized.match');
  const end = bg.indexOf('  if (/^cs\\s+/i.test(normalized)) {', start);
  assert(start >= 0 && end > start, 'dictionary omnibox route missing');
  const route = bg.slice(start, end);
  assert(route.includes('dictMatch = normalized.match'), 'dict prefix parser missing');
  assert(route.includes('/^[A-Za-z]+$/.test(word)'), 'dictionary route must accept only a single alphabetic word');
  assert(route.includes("'https://webstersdictionary1828.com/Dictionary/' + encodeURIComponent(word)"), 'valid word entry destination missing');
  assert(route.includes("'https://webstersdictionary1828.com/'"), 'bare, multiword, or invalid input must route to Webster homepage');
  assert(route.includes('await chrome.tabs.update({url});'), 'dictionary route must open selected destination');
  assert(route.includes('return;'), 'dict prefix must not fall through to Bible search');
});
test('Omnibox command path remains wired', () => {
  const bg = read('background.js');
  assert(bg.includes('omnibox.onInputEntered'), 'omnibox listener missing');
  assert(bg.includes('handleOmniboxCommand'), 'omnibox handler missing');
  assert(bg.includes('SEARCH_RANGES'), 'Criteria search ranges missing');
});
test('permission Allow/Deny/Re-Allow lifecycle remains wired', () => {
  const bg = read('background.js'), popup = read('popup.js');
  assert(bg.includes('permissions?.onAdded') || bg.includes('onAdded?.addListener'), 'permission-added activation missing');
  assert(bg.includes('permissions.contains'), 'permission detection missing');
  assert(bg.includes('permissions') && bg.includes('request'), 'permission request missing');
  assert(popup.includes('chrome.permissions.request({origins:[currentSiteOrigin]})'), 'site-access permission request missing');
  assert(popup.includes('pinSiteFeatureChoice'), 'site-feature preference must be pinned before the permission prompt');
  assert(popup.includes('setPageButton(on)'), 'site feature enable/disable state missing');
  assert(popup.includes('sites[state.siteKey] = !!on'), 'site feature state persistence missing');
});
test('reload/new-tab persistence and dynamic activation remain wired', () => {
  const bg = read('background.js'), content = read('content.js');
  assert(bg.includes('chrome.runtime.onStartup'), 'startup handling missing');
  assert(bg.includes('chrome.tabs.onUpdated'), 'navigation activation missing');
  assert(bg.includes('chrome.storage.onChanged'), 'storage activation missing');
  assert(content.includes('chrome.storage.onChanged'), 'content persistence listener missing');
});
test('popup exposes all core feature controls', () => {
  const popup = read('popup.js');
  for (const control of ['master','pageButton','doubleClick','redirectEnabled']) {
    assert(popup.includes("getElementById('" + control + "')") || popup.includes('getElementById("' + control + '")'), 'popup control missing: ' + control);
  }
});
test('popup loading indicator is always cleared after initial state-load failure', () => {
  const popup = read('popup.js');
  const start = popup.indexOf('(async () => {', popup.lastIndexOf('studyBackupFileInput?.addEventListener'));
  const end = popup.indexOf('})();', start);
  assert(start >= 0 && end > start, 'popup initialization block missing');
  const init = popup.slice(start, end);
  assert(init.includes('try {') && init.includes('render(await getState())'), 'initial state render must be guarded');
  assert(init.includes('catch (error)') && init.includes("console.error('KJV Scripture Tools popup initialization failed:'"), 'initialization failure must be diagnosable');
  assert(init.includes('finally {') && init.includes("document.body.classList.remove('popup-loading')"), 'popup must be made visible even when state loading fails');
});

}
