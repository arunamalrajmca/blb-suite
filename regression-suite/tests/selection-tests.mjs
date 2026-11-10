export function registerSelectionContextTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
section('selection');
test('web contextual resolver is present', () => {
  for (const s of ['getContextualBibleReference','resolveBibleReferenceFromContextWindow','blbSuiteResolveContextualSelection']) assert(bg.includes(s)||content.includes(s), s);
});
test('PDF path uses shared downstream resolver', () => {
  assert(bg.includes('openSelectedPdfBibleRefs'), 'missing PDF shared handler');
  assert(bg.includes('classifySelectionForBlb'), 'PDF path must use shared classifier');
});
test('PDF protected-viewer fallback is explicit', () => {
  assert(bg.includes('Chrome/Brave PDF viewers and protected pages may reject content-script'), 'expected protected PDF fallback comment missing');
});
test('case-sensitive zero-result fallback cannot redirect to BLB home', () => {
  const start=bg.indexOf('async function handleCaseSensitiveBCommand');
  const end=bg.indexOf('\nasync function handleOmniboxCommand', start);
  const fn=bg.slice(start,end);
  assert(fn.includes('openCaseSensitiveNativeSearch(parsed.rawQuery, disposition)'), 'native fallback missing');
  assert(!fn.includes("chrome.tabs.update({url:homeUrl})"), 'unsafe BLB-home fallback remains');
});
test('case-sensitive MultiVerse results use the shared canonical batch handoff', () => {
  const start=bg.indexOf('async function handleCaseSensitiveBCommand');
  const end=bg.indexOf('\nasync function handleOmniboxCommand', start);
  assert(start >= 0 && end > start, 'case-sensitive command handler block missing');
  const handler=bg.slice(start,end);
  assert(handler.includes('openBlbMultiVerseRefs(multiVerseRefs, disposition !== \'newBackgroundTab\', {preferredTabId:originatingTabId})'), 'case-sensitive results must use the shared MultiVerse batch manager');

  const batchStart=bg.indexOf('async function openBlbMultiVerseRefs(');
  const batchEnd=bg.indexOf('\n// Shared destination identity/reuse/creation coordinator', batchStart);
  assert(batchStart >= 0 && batchEnd > batchStart, 'shared MultiVerse batch manager missing');
  const batch=bg.slice(batchStart,batchEnd);
  assert(batch.includes('offset += BLB_MULTIVERSE_MAX_VERSES'), 'shared manager must preserve the 200-verse batch limit');
  assert(batch.includes('openBlbMultiVerseRefsSingleBatch'), 'each batch must use the shared single-batch handoff');
  assert(batch.includes('Promise.all(batches.map'), 'all batches must be scheduled through the shared handoff path');
  assert(bg.includes('function grantMultiVersePostSlot'), 'shared FIFO POST scheduling must remain available');
});

test('case-sensitive zero-result path preserves native-search fallback', () => {
  const start=bg.indexOf('async function handleCaseSensitiveBCommand');
  const end=bg.indexOf('\nasync function handleOmniboxCommand', start);
  assert(start >= 0 && end > start, 'case-sensitive command handler block missing');
  const handler=bg.slice(start,end);
  const zeroResultStart=handler.indexOf('if (!matches.length)');
  const zeroResultEnd=handler.indexOf('\n  }', zeroResultStart);
  assert(zeroResultStart >= 0 && zeroResultEnd > zeroResultStart, 'case-sensitive zero-result branch missing');
  const zeroResultBranch=handler.slice(zeroResultStart,zeroResultEnd);
  assert(zeroResultBranch.includes('openCaseSensitiveNativeSearch(parsed.rawQuery, disposition)'), 'zero-result path must preserve the original query through native search');
});

test('expected PDF limitation remains documented by test policy', () => {
  assert.equal(fixture.pdfPolicy,'expected-limitation');
});

test('Official KJB redirect parser supports chapter and verse URLs', () => {
  const redirect = read('source-bible-redirect.js');
  const start = redirect.indexOf('if (host==="officialkingjamesbible.com")');
  const end = redirect.indexOf('\n  if (host==="bibleportal.com")', start);
  assert(start >= 0 && end > start, 'Official KJB redirect block missing');
  const parser = redirect.slice(start, end);
  assert(parser.includes('from:m[3]?+m[3]:1'), 'Official KJB verse capture is not used');
  assert(parser.includes('m[4]?+m[4]:null'), 'Official KJB verse-range capture is not used');
});

test('Bible redirect parser contracts cover every supported Bible redirect grammar', () => {
  const content = read('content.js');
  const redirect = read('source-bible-redirect.js');
  assert(redirect.includes('function redirectBibleSite'), 'Bible redirect parser block missing');
  const parser = redirect;

  const contracts = [
    ['bible.com', 'u.pathname.match', 'path parser'],
    ['biblegateway.com', 'u.searchParams.get("search")', 'passage search parameter'],
    ['bibleref.com', 'new RegExp("-"+p[1]+"-', 'chapter/verse filename parser'],
    ['biblehub.com', 'u.pathname.match', 'path parser'],
    ['kingjamesbibleonline.org', 'Chapter-', 'chapter-page parser'],
    ['kjbo.org', 'host==="kingjamesbibleonline.org" || host==="kjbo.org"', 'shared KJBO parser'],
    ['kjv.site', '-kjv', 'KJV.site URL parser'],
    ['officialkingjamesbible.com', '/bible/', 'Official KJB URL parser'],
    ['bibleportal.com', 'u.searchParams.get("v")', 'query-string verse parser']
  ];

  for (const [host, token, description] of contracts) {
    assert(redirect.includes(host), host);
    assert(parser.includes(token), host + ': ' + description + ' missing');
  }
  assert(content.includes('function redirectBlbNet'), 'BLB NET redirect parser missing');
  assert(content.includes('const REDIRECT_HOSTS'), 'redirect host table missing');
});

test('external redirect coverage includes every supported redirect host', () => {
  const content = read('content.js');
  const redirect = read('source-bible-redirect.js');
  const criteriaNavigation = read('criteria-search-navigation.js');
  for (const host of ['bible.com','biblegateway.com','bibleref.com','biblehub.com','kingjamesbibleonline.org','kjbo.org','kjv.site','officialkingjamesbible.com','bibleportal.com','webstersdictionary1828.com']) assert((content + redirect).includes(host), `redirect host missing: ${host}`);
  assert(criteriaNavigation.includes('blueletterbible.org'), 'Criteria Search navigation retains the BLB destination');
  assert(redirect.includes('function redirectBibleSite'), 'Bible-site redirect parser missing');
  assert(content.includes('function redirectBlbNet'), 'BLB NET redirect missing');
  assert(content.includes('const REDIRECT_HOSTS'), 'redirect host table missing');
});

test('BLB native-event interception remains explicitly scoped', () => {
  const content = read('content.js');
  const verseNavigation = read('blb-verse-link-navigation.js');
  const popup = read('blb-parse-popup.js');

  assert(popup.includes('const handleParsePopupLink'), 'parse-popup handler missing from its feature module');
  assert(popup.includes('link.closest(".parse-popup")') || popup.includes('link.closest?.(".parse-popup")'), 'parse-popup click override must remain selector-scoped');
  assert(popup.includes('preventDefault()'), 'parse-popup override must retain its intentional native-navigation override');
  assert(popup.includes('stopImmediatePropagation()'), 'parse-popup override must retain event isolation');

  const nowrapStart = verseNavigation.indexOf('const link = event.target.closest?.("a.nowrap")');
  const nowrapEnd = verseNavigation.indexOf('}, true);', nowrapStart);
  assert(nowrapStart >= 0 && nowrapEnd > nowrapStart, 'nowrap click handler missing from verse-link navigation module');
  const nowrap = verseNavigation.slice(nowrapStart, nowrapEnd + 8);
  assert(nowrap.includes('if (!link) return'), 'nowrap click override must reject unrelated clicks');
  assert(verseNavigation.includes('if (!isSuiteEnabledNow() || isModifiedLinkActivation(event)) return;'), 'nowrap override must preserve master-switch and modified-click behavior');
  assert(nowrap.includes('event.preventDefault()') && nowrap.includes('event.stopImmediatePropagation()'), 'nowrap override must preserve scoped native-event interception');

  const pageSelection = read('blb-page-selection-button.js');
  const selectionStart = pageSelection.indexOf('function handleBlbPageSelectionMouseDown');
  const selectionEnd = pageSelection.indexOf('function enableBlbPageButtonMonitoring', selectionStart);
  assert(selectionStart >= 0 && selectionEnd > selectionStart, 'selection-monitoring block missing');
  const selection = pageSelection.slice(selectionStart, selectionEnd);
  assert(!selection.includes('preventDefault()'), 'selection monitoring must not cancel native events');
  assert(!selection.includes('stopPropagation()'), 'selection monitoring must not stop native propagation');
  assert(!selection.includes('stopImmediatePropagation()'), 'selection monitoring must not stop native propagation');

  const dblStart = content.indexOf('function handleDoubleClickBlb');
  const dblEnd = content.indexOf('function enableDoubleClickBlb', dblStart);
  assert(dblStart >= 0 && dblEnd > dblStart, 'double-click block missing');
  const dbl = content.slice(dblStart, dblEnd);
  assert(!dbl.includes('preventDefault()'), 'double-click resolver must not cancel native dblclick');
  assert(!dbl.includes('stopPropagation()'), 'double-click resolver must not stop native propagation');
  assert(!dbl.includes('stopImmediatePropagation()'), 'double-click resolver must not stop native propagation');
});
test('BLB new-tab and Copy-as-link contracts remain wired', () => {
  const content = read('content.js');
  const verseNavigation = read('blb-verse-link-navigation.js');
  const autoHyperlinker = read('blb-auto-hyperlinker.js');
  const passiveNewTab = read('blb-passive-new-tab-targets.js');
  const draggableButton = read('blb-draggable-button.js');
  assert(content.includes('BLBPassiveNewTabTargetsModule?.initialize'), 'passive new-tab module is not initialized');
  assert(passiveNewTab.includes('applyPassiveNewTabTargets'), 'passive new-tab target handler missing');
  assert(passiveNewTab.includes('MutationObserver'), 'passive new-tab dynamic-link observer missing');
  assert(content.includes('BLBDraggableButtonModule?.makeBlbMultiVerseButtonDraggable'), 'draggable-button module is not wired');
  assert(draggableButton.includes('positionWriteQueue'), 'draggable-button position writes are not serialized');
  assert(draggableButton.includes('Reset button position'), 'draggable-button reset control missing');
  assert(content.includes('BLBVerseLinkNavigationModule?.initialize'), 'verse-link navigation module is not initialized');
  assert(verseNavigation.includes('function modifyLinks(container)'), 'BLB link modifier missing from verse-link navigation module');
  assert(verseNavigation.includes('link.target = "_blank"'), 'BLB new-tab target missing from verse-link navigation module');
  assert(autoHyperlinker.includes('formatBlbTextToHtml'), 'HTML clipboard formatter missing');
  assert(autoHyperlinker.includes('setData("text/html"'), 'HTML clipboard write missing');
  assert(autoHyperlinker.includes('setData("text/plain"'), 'plain-text clipboard fallback missing');
});
test('context-menu Show on BLB wiring remains present', () => {
  const bg = read('background.js'), content = read('content.js');
  assert(bg.includes('contextMenus'), 'contextMenus API wiring missing');
  assert(bg.includes('blbSuiteOpenSelectionText'), 'context-menu selection opener missing');
  assert(read('blb-page-selection-button.js').includes('blbSuiteSyncSelectionContextMenu'), 'context-menu synchronization missing');
});
test('Alt+B selection path remains wired', () => {
  const bg = read('background.js');
  assert(bg.includes('Alt+B'), 'Alt+B marker missing');
  assert(bg.includes('getActiveTabSelection'), 'Alt+B active selection path missing');
  assert(bg.includes('chrome.commands.onCommand'), 'extension command listener missing');
});

}

export function registerSelectionActionTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
section('selection');
test('Show on BLB and Alt+B share selection routing while Double-Click stays separate', () => {
  const bg = read('background.js');
  const content = read('content.js');
  assert(bg.includes('async function openSharedSelectionAction'), 'shared selection resolver missing');
  assert(bg.includes('return openSharedSelectionAction({'), 'Alt+B does not use the shared selection resolver');
  assert(bg.includes('const result = await openSharedSelectionAction({'), 'Show on BLB does not use the shared selection resolver');
  assert(bg.includes('if (isDoubleClickAction)'), 'Double-Click action-specific route missing');
  assert(content.includes('blbSuiteOpenDoubleClickSelectionText'), 'content script does not dispatch the separate Double-Click action');
});

test('Double-click BLB path remains wired', () => {
  const content = read('content.js');
  assert(content.includes('handleDoubleClickBlb'), 'double-click handler missing');
  assert(content.includes("addEventListener('dblclick'"), 'dblclick listener missing');
  assert(content.includes('blbSuiteOpenDoubleClickSelectionText'), 'dedicated double-click opener missing');
});
test('Double-click citation handling validates book labels and preserves nonconsecutive verse lists', () => {
  const content = read('content.js');
  const bg = read('background.js');
  assert(content.includes('let clickedWordRange = null;'), 'double-click must recover the word at the physical click location');
  assert(content.includes('clickedWordText = normalizeSelectionText(clickedWordRange.toString()).normalize(\'NFKC\');'), 'physical click word must replace stale native selection text');
  assert(content.includes('if (clickedWordRange && block.contains(clickedWordRange.startContainer))'), 'physical click range must override stale non-empty Selection offsets');
  assert(content.includes('if (textNode?.nodeType === Node.ELEMENT_NODE)'), 'double-click must handle caret APIs that return element boundaries');
  assert(content.includes('const findText = (root, fromEnd = false) =>'), 'element caret boundaries must be resolved to nearby text nodes');
  assert(content.includes('const candidateBook = resolveBibleBook(candidate)'), 'double-click citation must validate the actual captured book label, not parse unrelated prose');
  assert(content.includes('refs: resolvedVerses.map(ref => ({'), 'nonconsecutive comma-separated verses must remain separate references');
  assert(content.includes('book: ref.book.name,'), 'contextual verse refs must include the canonical book name required by the MultiVerse canonicalizer');
  assert(bg.includes('Array.isArray(message.contextualReference?.refs)'), 'background opener must accept multiple contextual verse references');
  assert(bg.includes('openBlbMultiVerseRefs(message.contextualReference.refs'), 'multiple contextual verses must use the shared MultiVerse opener');
});
test('Show on BLB floating button path remains wired', () => {
  const content = read('content.js');
  const pageSelection = read('blb-page-selection-button.js');
  assert(content.includes('BLBPageSelectionButtonModule.initialize'), 'page-selection module is not initialized');
  assert(pageSelection.includes('BLB_PAGE_BUTTON_ID'), 'floating button missing');
  assert(pageSelection.includes('addBlbPageSelectionButton'), 'button creation missing');
  assert(pageSelection.includes('updateBlbPageSelectionButtonFromSelection'), 'selection update path missing');
  assert(pageSelection.includes('blbSuiteOpenSelectionText'), 'button opener missing');
});

}

export function registerSelectionMultiVerseTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
section('selection');
test('MultiVerse creation/reuse path remains wired', () => {
  const bg = read('background.js');
  assert(bg.includes('createBlbTabGeneric'), 'BLB tab manager missing');
  assert(bg.includes('openSelectedPdfBibleRefs'), 'shared MultiVerse/reference opener missing');
  assert(bg.includes('createBlbTabGeneric'), 'MultiVerse tab creation/reuse missing');
});

}

export function registerSelectionClassificationTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
section('selection');
test('reference classification retains all major selection types', () => {
  const bg = read('background.js');
  for (const type of ['STRONG','REFERENCE','BOOK','KJV_WORD','KJV_PHRASE','KJV_PASSAGE','KJV_REFERENCE_RANGE','REFERENCE_AND_KJV_PASSAGE','NON_KJV_SINGLE_WORD']) {
    assert(bg.includes("'" + type + "'") || bg.includes('"'+type+'"'), 'classifier type missing: ' + type);
  }
});


}
