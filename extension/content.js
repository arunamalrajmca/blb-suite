// Top-level execution marker lets the browser E2E distinguish file execution
// from failures inside the async initializer below.
try { window.__blbSuiteContentScriptFileExecutedV3 = true; } catch (_) {}
(async function () {
// Lightweight test/diagnostic marker: content-script injection is distinct from
// whether the user's per-site double-click preference enables the listener.
try { window.__blbSuiteContentScriptLoadedV2 = true; } catch (_) {}
const BLB_HOSTNAME = BLBShared.hostnames.blb;
const BLB_ORIGIN = BLBShared.urls.blbOrigin;
// Unified content script.

// Access policy:
//   * Local files: only PDF, HTML, and HTM files are supported.
//   * Webpages: hostnames containing "bible" are enabled by default.
//     Other sites become active when the user has explicitly enabled either
//     Show on BLB or Double-Click BLB for that hostname. Those preferences
//     live in chrome.storage.local and survive extension updates.
async function blbSuiteAccessAllowed() {
  const protocol = String(location.protocol || '').toLowerCase();
  const href = String(location.href || '');

  if (protocol === 'file:') {
    return /\.(?:pdf|html?|xhtml)(?:$|[?#])/i.test(href);
  }

  if (protocol !== 'http:' && protocol !== 'https:') return false;

  const host = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
  if (!host) return false;
  if (host.includes('bible')) return true;

  try {
    const stored = await chrome.storage.local.get({pageSelectionButtonSites:{}, doubleClickBlbSites:{}});
    const pageSites = stored.pageSelectionButtonSites && typeof stored.pageSelectionButtonSites === 'object'
      ? stored.pageSelectionButtonSites : {};
    const doubleSites = stored.doubleClickBlbSites && typeof stored.doubleClickBlbSites === 'object'
      ? stored.doubleClickBlbSites : {};
    return pageSites[host] === true || doubleSites[host] === true;
  } catch (_) {
    return false;
  }
}
// Keep the content script resident on HTTP/HTTPS pages. Feature activation is
// controlled by the site settings below. Exiting the content script here made
// a later popup toggle unable to activate an already-open page reliably.
// Local-file support remains restricted to PDF/HTML/HTM by the manifest.

let suiteEnabled = false;
let doubleClickBlbEnabled = false;
let suiteSettingsReady = false;

// Cache the master setting in each content-script instance. This avoids a
// storage read on every copy/click/selection event while still reacting
// immediately to later setting changes through chrome.storage.onChanged.
const suiteSettingsReadyPromise = chrome.storage.local.get({masterEnabled:true, doubleClickBlbSites:{}}).then(data => {
  suiteEnabled = data.masterEnabled !== false;
  suiteSettingsReady = true;
  return suiteEnabled;
}).catch(() => {
  // Fail closed if the master setting cannot be read. A storage failure must
  // never temporarily activate Suite features while the extension is meant to be OFF.
  suiteEnabled = false;
  suiteSettingsReady = true;
  return suiteEnabled;
});

async function isSuiteEnabled() {
  if (!suiteSettingsReady) await suiteSettingsReadyPromise;
  return suiteEnabled;
}

// Runtime messaging can throw synchronously when an extension is reloaded or
// updated while an old content script is still attached to a page. Keep that
// stale-page condition silent and fail closed instead of surfacing
// "Extension context invalidated" to the user.
function safeRuntimeSendMessage(message) {
  try {
    const pending = chrome.runtime.sendMessage(message);
    if (pending && typeof pending.catch === 'function') return pending.catch(() => undefined);
    return Promise.resolve(pending);
  } catch (_) {
    return Promise.resolve(undefined);
  }
}

// Route Suite-owned BLB new-tab actions through the background single-owner
// destination manager. This prevents native/window.open tab creation from
// bypassing canonical reuse when the source page is reopened later.
// Let the browser handle modified link activations (new-tab/window, download, etc.).
// Suite only owns an unmodified primary-button click.
function isModifiedLinkActivation(event) {
  return Boolean(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

// Keep the URL normalizer and opener for BLB's own parsing-popup links.
// Ordinary-site ScriptTagger clicks are handled by redirect-scripttagger.js.
function normalizeBlbDestinationUrl(url) {
  const target = String(url || '').trim();
  try {
    const parsed = new URL(target);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    const hostname = parsed.hostname.toLowerCase();
    if (![BLB_HOSTNAME, BLBShared.hostnames.blbWww, BLBShared.hostnames.blbCom, BLBShared.hostnames.blbWwwCom].includes(hostname)) return '';
    parsed.protocol = 'https:';
    parsed.hostname = BLBShared.hostnames.blbWww;
    parsed.port = '';
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function isSensitiveSiteHostname(hostname) {
  return BLBShared.isSensitiveSiteHostname(hostname);
}

function openBlbDestinationFromContent(url) {
  const target = normalizeBlbDestinationUrl(url);
  if (!target) return;
  void safeRuntimeSendMessage({
    type: 'blbSuiteOpenBackgroundUrl',
    url: target,
    activeIfNew: true,
    activateExisting: true
  });
}

// Keep existing call sites stable while delegating pure normalization to its module.
const normalizeSelectionText = value => BLBSelectionTextModule.normalize(value);
const norm = value => BLBSelectionTextModule.normalizeKey(value);
const BLBSourceBibleRedirects = globalThis.BLBSourceBibleRedirectModule.create({
  books:BOOKS,
  shared:BLBShared,
  locationApi:location,
  resolveBibleBook,
  resolveBibleReference,
  openBlbDestinationFromContent
});
const { bookKey, decodeSafe, blbUrl, normalizeSourceBibleBook, formatSourceBibleBookName, parseRef, validateSourceBibleReference, parseChristianityBibleLink, christianityBibleLinkTarget, redirectBibleSite, theKingsBibleLinkTarget, redirectBlbNet } = BLBSourceBibleRedirects;

globalThis.BLBSourceSiteClickRedirectsModule?.initialize({
  windowApi:window,
  documentApi:document,
  locationApi:location,
  chromeApi:chrome,
  books:BOOKS,
  resolveBibleReference,
  blbUrl,
  christianityBibleLinkTarget,
  parseRef,
  theKingsBibleLinkTarget,
  openBlbDestinationFromContent,
  isModifiedLinkActivation,
  isSuiteEnabled,
  getCachedSuiteEnabled:() => suiteEnabled,
  isSourceRedirectEnabled:() => sourceBibleRedirectEnabled
});

// Match the same normalized hostname form used by background.js.
// This makes bare and "www." variants resolve to the same supported source.
const REDIRECT_HOSTS = new Set([
  'bible.com', 'biblegateway.com', 'bibleref.com', 'biblehub.com',
  'christianity.com', 'crosswalk.com', 'enduringword.com', 'esv.org', 'gotquestions.org',
  'rediscover.bible', 'sagacityweb.com', 'thetreasuryofscriptureknowledge.com',
  'bibleportal.com', 'kingjamesbibleonline.org', 'kjbo.org',
  'kjv.site', 'm.kjv.site', 'officialkingjamesbible.com', 'thekingsbible.com',
  'webstersdictionary1828.com', BLB_HOSTNAME
]);

let sourceBibleRedirectEnabled = false;

if (REDIRECT_HOSTS.has(location.hostname.toLowerCase().replace(/^www\./, ''))) {
  isSuiteEnabled().then(enabled => {
    if (!enabled) return;
    return chrome.storage.local.get({redirectEnabled:false}).then(({redirectEnabled})=>{
      sourceBibleRedirectEnabled = redirectEnabled === true;
      if (!redirectEnabled) return;
      if (!redirectBlbNet()) redirectBibleSite();
    });
  }).catch(() => {});
}
// MultiVerse native-copy enhancement is initialized as a feature module.
globalThis.BLBMultiVerseCopyLinksModule?.initialize({
  isSuiteEnabled: () => suiteEnabled,
  resolveBibleBook
});

// ---------- BLB Auto Hyperlinker ----------
globalThis.BLBAutoHyperlinkModule?.initialize({
  isSuiteEnabled,
  getCachedEnabled: () => suiteEnabled,
  blbHostname: BLB_HOSTNAME,
  blbHomeUrl: BLBShared.urls.blbHome
});

if (location.hostname.endsWith(BLB_HOSTNAME) &&
    !/(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)) {
  // Preserve the existing scope: Criteria Search and MultiVerse have dedicated handlers.
  globalThis.BLBParsePopupLinksModule?.initialize({
    getCachedEnabled: () => suiteEnabled,
    isModifiedLinkActivation,
    openBlbDestinationFromContent,
    blbHostname: BLB_HOSTNAME,
    blbSearchUrl: BLBShared.urls.blbSearch
  });
}
globalThis.BLBNewTabLinksModule?.initialize({
  getCachedEnabled: () => suiteEnabled,
  isModifiedLinkActivation,
  openBlbDestinationFromContent,
  blbHostname: BLB_HOSTNAME
});

// Isolate the Suite-owned MultiVerse and Criteria Search navigation handlers.
globalThis.BLBNavigationLinksModule?.initialize({
  getCachedEnabled: () => suiteEnabled,
  isModifiedLinkActivation,
  safeRuntimeSendMessage,
  openBlbDestinationFromContent,
  blbHostname: BLB_HOSTNAME,
  blbSearchUrl: BLBShared.urls.blbSearch
});

// Keep native BLB verse links opening in a new tab without intercepting clicks.
globalThis.BLBPassiveNewTabModule?.initialize({
  getCachedEnabled: () => suiteEnabled,
  blbHostname: BLB_HOSTNAME
});

// Shared drag behavior for page-wide MultiVerse buttons. Position is stored
// in extension-local storage so it survives reloads and browser restarts.
// Shared drag behavior lives in a classic-script module with explicit browser APIs.
const makeBlbMultiVerseButtonDraggable = globalThis.BLBMultiVerseButtonDragModule.create({
  documentApi:document,
  windowApi:window,
  chromeApi:chrome,
  getComputedStyleFn:getComputedStyle,
  MutationObserverCtor:MutationObserver
}).makeBlbMultiVerseButtonDraggable;

// The feature module is loaded before this content script by manifest order.
globalThis.BLBKingsBibleCollector.initialize({
  BOOKS,
  normalizeSelectionText,
  parseRef,
  resolveBibleReference,
  blbUrl,
  isSuiteEnabled,
  makeBlbMultiVerseButtonDraggable
});

// The Webster feature module is loaded before this content script.
globalThis.BLBWebsterCollectorModule?.initialize({
  normalizeSelectionText,
  parseRef,
  blbUrl,
  isSuiteEnabled,
  isSuiteEnabledNow: () => suiteEnabled,
  isModifiedLinkActivation,
  makeBlbMultiVerseButtonDraggable
});

// Source-page collection feature module is loaded before content.js.
globalThis.BLBSourcePageCollectorModule?.initialize({
  normalizeSelectionText,
  parseRef,
  normalizeSourceBibleBook,
  resolveBibleReference,
  blbUrl,
  formatSourceBibleBookName,
  isSuiteEnabled,
  makeBlbMultiVerseButtonDraggable
});

// Keep MultiVerse hand-off and study capture isolated behind an explicit API.
globalThis.BLBMultiVerseHandoffModule?.initialize({
  isSuiteEnabled,
  resolveBibleBook,
  normalizeSelectionText,
  blbHostname: BLB_HOSTNAME,
  blbWwwHostname: BLBShared.hostnames.blbWww
});

// ---------- Double-Click BLB ----------
// Double-click a single KJV word, Bible book name, or standalone book number.
// Uses the Suite's own selection logic and never invokes BLB's native search.
const { resolveNearestChapterContext } = globalThis.BLBDoubleClickReferenceContextModule.create({
  books:BOOKS,
  bookAliases:BOOK_ALIASES,
  resolveBibleReference
});

const BLBDoubleClickContext = globalThis.BLBDoubleClickContextModule.create({
  documentApi:document,
  windowApi:window,
  NodeCtor:Node,
  ElementCtor:Element,
  books:BOOKS,
  shared:BLBShared,
  normalizeSelectionText,
  parseRef,
  validateSourceBibleReference,
  getDoubleClickTargetElement,
  resolveBibleBook,
  resolveBibleReferenceText,
  resolveBibleReference,
  resolveNearestChapterContext
});
const { normalizeDoubleClickToken, getAdjacentBoundaryText, getSelectionContextPosition, resolveBibleReferenceFromContextWindow, getContextualBibleReference, getStandaloneBookReference, isBibleVersionCodeToken, getDoubleClickBlockContextReference } = BLBDoubleClickContext;

// ---------- Double-Click BLB ----------
// Double-click is an entry point into the same background selection resolver.
// It must not maintain a second Bible/reference parser here.
let doubleClickBound = false;
let doubleClickSettingsReady = false;
let doubleClickSettingsRefreshPromise = null;
const recentDoubleClickDestinations = new WeakMap();
let doubleClickRequestSequence = 0;
const DOUBLE_CLICK_WINDOW_GUARD = '__blbSuiteDoubleClickBoundV2';


function isDoubleClickExcludedTarget(target) {
  return !!target?.closest?.('input,textarea,select,button,[contenteditable="true"],[contenteditable=""]');
}

function getDoubleClickTargetElement(event) {
  // Prefer the element actually under the double-click coordinates. Chromium
  // can report the surrounding paragraph as event.target when the native
  // Selection is still settling, while elementFromPoint identifies the inline
  // token that received the physical gesture.
  try {
    const pointTarget = Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;
    const candidates = [pointTarget, event?.target];
    for (const candidate of candidates) {
      if (!(candidate instanceof Element)) continue;
      const token = candidate.closest?.('[data-index], .reference-token') || candidate;
      const text = normalizeSelectionText(token.textContent || '');
      if (text && !/\s/.test(text) && /^[A-Za-z0-9][A-Za-z0-9.'-]*$/.test(text)) return token;
    }

    // If the click lands on an inter-token whitespace gap, recover the nearest
    // reference-token from the same block. This is still coordinate-local and
    // cannot borrow context from another paragraph or document-wide reference.
    if (pointTarget instanceof Element && Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
      const block = pointTarget.closest?.('p,li,td,th,blockquote,article,section,div');
      if (block) {
        let nearest = null;
        let bestDistance = Infinity;
        for (const token of block.querySelectorAll('[data-index], .reference-token')) {
          const text = normalizeSelectionText(token.textContent || '');
          if (!text || /\s/.test(text) || !/^[A-Za-z0-9][A-Za-z0-9.'-]*$/.test(text)) continue;
          const rect = token.getBoundingClientRect();
          const dx = event.clientX < rect.left ? rect.left - event.clientX : event.clientX > rect.right ? event.clientX - rect.right : 0;
          const dy = event.clientY < rect.top ? rect.top - event.clientY : event.clientY > rect.bottom ? event.clientY - rect.bottom : 0;
          const distance = Math.hypot(dx, dy);
          if (distance < bestDistance) {
            bestDistance = distance;
            nearest = token;
          }
        }
        if (nearest) return nearest;
      }
    }
  } catch (_) {}
  return null;
}

// A standalone numeric double-click at the start of a text block may be
// a numbered-list label rather than a Bible reference. Detect the label from
// the physical click position and its punctuation; do not suppress standalone
// book-number gestures (1–66) unless the clicked number is visibly followed by
// a period at the start of the block. This guard is specific to double-click.
function isNumberedListSerialDoubleClick(selectionText, event) {
  const selected = normalizeSelectionText(selectionText).normalize('NFKC');
  if (!/^\d+$/.test(selected)) return false;
  const number = Number(selected);
  if (!Number.isSafeInteger(number) || number < 0) return false;

  try {
    let pointRange = null;
    if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
      if (typeof document.caretRangeFromPoint === 'function') {
        pointRange = document.caretRangeFromPoint(event.clientX, event.clientY);
      } else if (typeof document.caretPositionFromPoint === 'function') {
        const point = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (point?.offsetNode) {
          pointRange = document.createRange();
          pointRange.setStart(point.offsetNode, point.offset);
          pointRange.collapse(true);
        }
      }
    }

    const nativeSelection = window.getSelection?.();
    const nativeRange = nativeSelection?.rangeCount ? nativeSelection.getRangeAt(0) : null;
    const range = pointRange || nativeRange;
    if (!range) return false;

    let node = range.startContainer;
    let offset = range.startOffset;
    if (node?.nodeType !== Node.TEXT_NODE) {
      const children = node?.childNodes || [];
      const right = children[Math.min(offset, children.length)] || null;
      const left = offset > 0 ? children[offset - 1] : null;
      if (right?.nodeType === Node.TEXT_NODE) { node = right; offset = 0; }
      else if (left?.nodeType === Node.TEXT_NODE) { node = left; offset = (left.nodeValue || '').length; }
      else return false;
    }

    const value = String(node.nodeValue || '');
    let start = Math.max(0, Math.min(offset, value.length));
    if (start === value.length || !/\d/.test(value[start] || '')) start--;
    while (start > 0 && /\d/.test(value[start - 1])) start--;
    let end = start;
    while (end < value.length && /\d/.test(value[end])) end++;
    if (start < 0 || value.slice(start, end) !== selected || value[end] !== '.') return false;

    const block = node.parentElement?.closest?.('p,li,td,th,blockquote,article,section,div') || node.parentElement;
    if (!block) return false;
    const before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(node, start);
    return !normalizeSelectionText(before.toString());
  } catch (_) {
    return false;
  }
}

function getDoubleClickSelection(event) {
  const selection = normalizeSelectionText(window.getSelection ? window.getSelection().toString() : '');
  if (selection) return selection;

  // Chromium can deliver dblclick before the native Range is populated. Use
  // the exact token under the physical gesture rather than trusting a
  // transient whitespace-only Selection.
  const targetElement = getDoubleClickTargetElement(event);
  const targetText = normalizeSelectionText(targetElement?.textContent || '');
  if (targetText) return targetText;
  return '';
}

function handleDoubleClickBlb(event) {
  try {
    if (!suiteEnabled || isSensitiveSiteHostname(location.hostname) || isDoubleClickExcludedTarget(event.target)) return;

    // Chromium may dispatch dblclick before the new word selection has replaced
    // the previous native selection. Never freeze that early selection/context:
    // a stale selection can make a real chapter-number double-click inherit an
    // unrelated reference from the preceding gesture.
    if (!doubleClickSettingsReady) {
      void ensureDoubleClickSettingsReady().then(() => {
        if (doubleClickBlbEnabled) handleDoubleClickBlb(event);
      });
      return;
    }
    if (!doubleClickBlbEnabled) return;

    const started=Date.now();
    const requestId=`dblclick-${Date.now()}-${++doubleClickRequestSequence}`;
    const dispatch=()=>{
      try {
        // Re-read the native selection on every frame until Chromium commits
        // the current double-click. The physical event coordinates remain the
        // authoritative target while the Selection is settling.
        let selection=getDoubleClickSelection(event);
        // On double-click, Chromium may still expose the previous word's
        // non-empty Selection. For the narrowly supported verse-context
        // gesture, the physical event target is authoritative: use its exact
        // token before classifying the gesture, or the post-level resolver
        // never runs when Selection is stale.
        const eventTarget = event.target instanceof Element
          ? event.target
          : (event.target?.parentElement || null);
        const caretTarget = getDoubleClickTargetElement(event);
        const cueTarget = [eventTarget, caretTarget].find(candidate =>
          /^(?:v|verse|verses)$/i.test(
            normalizeSelectionText(candidate?.textContent || '').normalize('NFKC')
          )
        );
        const physicalToken = normalizeSelectionText(cueTarget?.textContent || '').normalize('NFKC');
        if (cueTarget && /^(?:v|verse|verses)$/i.test(physicalToken)) selection = physicalToken;
        if (!selection) {
          if (Date.now()-started<1500) requestAnimationFrame(dispatch);
          return true;
        }

        // Numbered-list labels above the 66-book range must not borrow a
        // nearby Bible reference from the same paragraph. Numbers 1–66 remain
        // valid standalone book gestures even when formatted as list labels.
        // This guard is double-click-only; floating-button and Alt+B are untouched.
        const isNumberedListSerial = isNumberedListSerialDoubleClick(selection, event);
        if (isNumberedListSerial && (Number(selection) === 0 || Number(selection) > 66)) return true;

        // Strong's values are lexicon identifiers, not ordinary KJV words.
        // Double-clicking G/H numbers (including a linked value on The King's
        // Bible) should open the corresponding BLB lexicon entry directly.
        const physicalTarget = event.target instanceof Element
          ? event.target
          : (event.target?.parentElement || null);
        const strongLink = physicalTarget?.closest?.('a[href]');
        const strongValuePattern = /^(?:Strong(?:['’]s?)?\s*)?([GH])\s*0*(\d+)$/i;
        let strongsMatch = [selection, physicalTarget?.textContent, caretTarget?.textContent]
          .map(value => normalizeSelectionText(value || '').normalize('NFKC'))
          .map(value => value.match(strongValuePattern))
          .find(Boolean) || null;
        if (!strongsMatch && strongLink) {
          try {
            const strongPath = new URL(strongLink.href, location.href).pathname;
            strongsMatch = strongPath.match(/^\/StrongsNo\/([GH])0*(\d+)\/?$/i);
          } catch (_) {}
        }
        if (strongsMatch) {
          const language = strongsMatch[1].toLowerCase();
          const strongNumber = Number(strongsMatch[2]);
          if (Number.isSafeInteger(strongNumber) && strongNumber > 0) {
            const lexiconUrl = `${BLBShared.urls.blbOrigin}/lexicon/${language}${strongNumber}/kjv/${language === 'h' ? 'wlc' : 'tr'}/0-1/`;
            openBlbDestinationFromContent(lexiconUrl);
          }
          return true;
        }

        // Fast-reject a single non-ASCII token (including Tamil) before
        // DOM/context scanning. BLB's word lookup is English KJV; these tokens
        // cannot be valid KJV word searches. Keep multiword/reference selections
        // on the normal path so contextual Bible references still work.
        const isReferenceDashGesture=/^[\u2010-\u2015\u2212-]+$/.test(selection);
        if (!/\s/.test(selection) && /[^\x00-\x7F]/.test(selection) && !isReferenceDashGesture) return true;

        // Bible-version abbreviations are reference-context tokens, not word
        // searches. If one is double-clicked beside a reference, resolve that
        // reference and open it in BLB's default KJV view regardless of the
        // clicked version code.
        const isBibleVersionCode = isBibleVersionCodeToken(selection);
        // Verse cues must reach the narrowly scoped Facebook post resolver
        // even when "verse" is absent from the generated KJV word index.
        // Declare this outside the fast-rejection block because target selection
        // and the DOM-context resolver also need the same cue classification.
        const isVerseContextWord = /^(?:v|verse|verses)$/i.test(selection);

        // Reject unrelated English single words before building DOM context or
        // entering the background selection resolver. This is an exact local
        // membership check against the corpus-derived KJV vocabulary index.
        // Known Bible-version codes are the exception: scan their surrounding
        // text for a reference, but never send the code itself for word lookup.
        if (/^[A-Za-z][A-Za-z'’\\-]*$/.test(selection)) {
          const token = normalizeDoubleClickToken(selection).replace(/’/g, "'");
          const isKjvWord = typeof KJV_CORPUS_WORD_INDEX !== 'undefined'
            && KJV_CORPUS_WORD_INDEX.has(token);
          const isBookName = !!resolveBibleBook(selection);
          // Roman numeral tokens can be the prefix of a numbered Bible book
          // (II Samuel, III John). Let them reach the tightly gated nearby-
          // reference check below; without a valid nearby prefix they remain
          // inert and are not sent to ordinary word lookup.
          const isRomanBookPrefixToken = /^(?:I|II|III)$/i.test(selection);
          if (!isBibleVersionCode && !isKjvWord && !isBookName && !isRomanBookPrefixToken && !isVerseContextWord) return true;
        }

        // DOM context is useful only when the clicked token can identify a
        // Bible reference: a standalone number in the supported 1-176 range,
        // a recognized Bible book name, or a known Bible-version code.
        // Ordinary KJV words still proceed to word lookup without scanning
        // the surrounding DOM.
        const isNumericBookCandidate=/^\d+$/.test(selection)
          && Number(selection)>=1 && Number(selection)<=176;
        // A numeric prefix is valid only when the complete prefixed book
        // name resolves (for example, "1 Samuel" or "3 John"). Do not fall
        // back to resolving the suffix alone: "4 John" and "2 Genesis" must
        // not trigger DOM-context analysis.
        const hasNumericPrefix=/^[1-9]\s+/.test(selection);
        const selectionKey=normalizeDoubleClickToken(selection).toLowerCase();
        const isKnownBookAlias=Object.keys(BOOK_ALIASES||{}).some(alias =>
          normalizeDoubleClickToken(alias).toLowerCase()===selectionKey
        );
        const isPrefixedBookName=hasNumericPrefix && (!!resolveBibleBook(selection)||isKnownBookAlias);
        const isBookName=!hasNumericPrefix && (!!resolveBibleBook(selection)||isKnownBookAlias);
        // For explicit verse cues, preserve the physical event target. The generic caret-target helper can return a nearby/stale element, which prevents the post-level resolver from finding the containing message. Other gestures retain the existing target selection behavior.
        const cueElement = [event.target instanceof Element ? event.target : event.target?.parentElement,
          getDoubleClickTargetElement(event)].find(candidate =>
            /^(?:v|verse|verses)$/i.test(normalizeSelectionText(candidate?.textContent || '').normalize('NFKC'))
          );
        const contextualTarget=isVerseContextWord
          ? (cueElement || (event.target instanceof Element ? event.target : (event.target?.parentElement || event.target)))
          : (getDoubleClickTargetElement(event)||event.target);

        // A suffix such as "Peter" or "Sam" can be part of a numbered book
        // name. Only enter contextual matching when the complete nearby prefix
        // resolves to a real Bible book; arbitrary words remain fast-rejected.
        const possibleNumberedBookSuffix=/^(?:Sam(?:uel)?|Kings|Kgs?|Chronicles|Chr|Corinthians|Cor|Thessalonians|Thess|Timothy|Tim|Peter|Pet|John|Jn|Jhn)$/i.test(selection);
        const isRomanBookPrefix=/^(?:I|II|III)$/i.test(selection);
        let hasValidNearbyBookPrefix=false;
        let hasValidNearbyRomanBookPrefix=false;
        if ((possibleNumberedBookSuffix||isRomanBookPrefix) && !hasNumericPrefix) {
          try {
            const contextNode=contextualTarget instanceof Element
              ? (contextualTarget.closest('p,li,td,th,blockquote,article,section,div')||contextualTarget.parentElement||contextualTarget)
              : (event.target?.parentElement||event.target);
            const contextText=normalizeSelectionText(contextNode?.textContent||'');
            const match=contextText.match(/(?:^|[^A-Za-z0-9])([1-3]|I{1,3})\s+(Samuel|Sam|Kings|Kgs|Chronicles|Chr|Corinthians|Cor|Thessalonians|Thess|Timothy|Tim|Peter|Pet|John|Jn|Jhn)\b/i);
            const prefixNumber=match
              ? (/^[1-3]$/.test(match[1]) ? match[1] : ({I:'1',II:'2',III:'3'}[match[1].toUpperCase()]||''))
              : '';
            const completeBook=!!(match && prefixNumber && resolveBibleBook(prefixNumber+' '+match[2]));
            hasValidNearbyBookPrefix=!!(completeBook
              && match[2].toLowerCase()===selection.toLowerCase()
              && /^[1-3]$/.test(match[1]));
            hasValidNearbyRomanBookPrefix=!!(completeBook
              && isRomanBookPrefix
              && match[1].toUpperCase()===selection.toUpperCase());
          } catch (_) {}
        }
        // "verse" is not guaranteed to be in the local KJV word index on
        // every build, but in a Facebook post it is the explicit cue for a
        // nearby verse number. Let the tightly gated post resolver inspect it.
        const needsDomContext=isNumericBookCandidate||isBookName||isPrefixedBookName||hasValidNearbyBookPrefix||hasValidNearbyRomanBookPrefix||isBibleVersionCode||isReferenceDashGesture||isVerseContextWord;
        const blockContext=needsDomContext
          ? getDoubleClickBlockContextReference(selection,contextualTarget,event)
          : null;

        // A verse cue is allowed to associate only with a valid verse number
        // (1–176). Psalm 119 is the maximum KJV chapter length; larger adjacent
        // numbers must not fall through to ordinary word lookup or inherit the
        // chapter context as if they were verses.
        if (isVerseContextWord) {
          const cueRoot = contextualTarget instanceof Element
            ? contextualTarget.closest(
              '[data-ad-comet-preview="message"], [role="article"], article, main, [role="main"], ' +
              '[itemprop="articleBody"], .dt-post-body, .available-content, .post-content, ' +
              '.entry-content, .article-body, .article-content, .content-body'
            )
            : null;
          try {
            const cueDiagnostic = JSON.parse(cueRoot?.getAttribute('data-blb-verse-context-diagnostic') || '{}');
            if (Number.isInteger(cueDiagnostic.followingVerse) &&
                (cueDiagnostic.followingVerse < 1 || cueDiagnostic.followingVerse > 176)) return true;
          } catch (_) {}
        }

        // Wait for the native selection/context to settle only for a number
        // that could be a standalone book number or part of a Bible reference.
        if (isNumericBookCandidate && !blockContext && !isNumberedListSerial && Date.now()-started<1500) {
          requestAnimationFrame(dispatch);
          return true;
        }

        const standaloneBook=isNumericBookCandidate
          ? getStandaloneBookReference(selection)
          : null;
        const blockText=isNumericBookCandidate ? normalizeSelectionText(
          event?.target?.closest?.('p,li,td,th,blockquote,article,section,div')?.textContent||''
        ) : '';
        const isStandaloneNumericBook=isNumericBookCandidate && standaloneBook && blockText===selection;
        const contextualReference=isNumberedListSerial && standaloneBook
          ? standaloneBook
          : (isStandaloneNumericBook ? standaloneBook : (blockContext||standaloneBook));
        if (!contextualReference) {
          // A version abbreviation alone is not a KJV word-search request.
          if (isBibleVersionCode) return true;
          if (/^[A-Za-z][A-Za-z'’-]*$/.test(selection) && !/^(?:i|ii|iii)$/i.test(selection)) {
            const now=Date.now();
            const gestureTarget=event?.target && (typeof event.target==='object'||typeof event.target==='function') ? event.target : null;
            if (gestureTarget) {
              const previous=recentDoubleClickDestinations.get(gestureTarget)||0;
              if (now-previous<1200) return true;
              recentDoubleClickDestinations.set(gestureTarget,now);
            }
            safeRuntimeSendMessage({
              type:'blbSuiteOpenSelectionText',
              text:selection,
              contextualReference:null,
              contextualReferenceResolved:true,
              requestId,
              tabBehavior:{activeIfNew:false,activateExisting:true}
            });
            return true;
          }
          if (isNumericBookCandidate && Date.now()-started<1500) requestAnimationFrame(dispatch);
          return true;
        }

        const now=Date.now();
        const gestureTarget=event?.target && (typeof event.target==='object'||typeof event.target==='function') ? event.target : null;
        if (gestureTarget) {
          const previous=recentDoubleClickDestinations.get(gestureTarget)||0;
          if (now-previous<1200) return true;
          recentDoubleClickDestinations.set(gestureTarget,now);
        }

        safeRuntimeSendMessage({
          type:'blbSuiteOpenSelectionText',
          text:selection,
          contextualReference,
          contextualReferenceResolved:true,
          requestId,
          tabBehavior:{activeIfNew:false,activateExisting:true}
        });
        return true;
      } catch (error) {
        try {
          const debugRoot = event?.target?.closest?.('article,main,[role="article"],[role="main"],.article-content') || document.documentElement;
          debugRoot?.setAttribute('data-blb-doubleclick-debug-error', String(error?.stack || error));
        } catch (_) {}
        return false;
      }
    };

    requestAnimationFrame(dispatch);
  } catch (error) {
    try { document.documentElement?.setAttribute('data-blb-doubleclick-debug-error', String(error?.stack || error)); } catch (_) {}
  }
}

function enableDoubleClickBlb() {
  if (doubleClickBound) return;
  try {
    const previous = window[DOUBLE_CLICK_WINDOW_GUARD];
    if (typeof previous === 'function' && previous !== handleDoubleClickBlb) {
      document.removeEventListener('dblclick', previous, true);
    }
    document.addEventListener('dblclick', handleDoubleClickBlb, true);
    doubleClickBound = true;
    window[DOUBLE_CLICK_WINDOW_GUARD] = handleDoubleClickBlb;
  } catch (_) {
    try { document.addEventListener('dblclick', handleDoubleClickBlb, true); doubleClickBound = true; } catch (_) {}
  }
}

function disableDoubleClickBlb() {
  if (!doubleClickBound) return;
  document.removeEventListener('dblclick', handleDoubleClickBlb, true);
  doubleClickBound = false;
}

async function getSiteDefaultEnabled() {
  try {
    const response = await safeRuntimeSendMessage({
      type:'blbSuiteGetDefaultSiteStatus',
      hostname:location.hostname,
      title:document.title || ''
    });
    return response?.enabled === true;
  } catch (_) {
    return false;
  }
}

async function refreshDoubleClickBlb() {
  try {
    const siteKey = getPageSelectionSiteKey();
    if (siteKey === BLB_HOSTNAME || isSensitiveSiteHostname(siteKey) || !suiteEnabled || !siteKey) {
      doubleClickBlbEnabled = false;
      disableDoubleClickBlb();
      return;
    }
    const data = await chrome.storage.local.get({doubleClickBlbSites:{}});
    const sites = data.doubleClickBlbSites && typeof data.doubleClickBlbSites === 'object'
      ? data.doubleClickBlbSites : {};
    const hasExplicitPreference = Object.prototype.hasOwnProperty.call(sites, siteKey);
    const defaultEnabled = await getSiteDefaultEnabled();
    doubleClickBlbEnabled = hasExplicitPreference ? sites[siteKey] === true : defaultEnabled;
    if (doubleClickBlbEnabled) enableDoubleClickBlb();
    else disableDoubleClickBlb();
  } catch (_) {
    // Fail closed if site-feature settings or defaults cannot be read.
    doubleClickBlbEnabled = false;
    disableDoubleClickBlb();
  }
}

function ensureDoubleClickSettingsReady() {
  if (doubleClickSettingsReady) return Promise.resolve();
  if (!doubleClickSettingsRefreshPromise) {
    doubleClickSettingsRefreshPromise = suiteSettingsReadyPromise
      .then(() => refreshDoubleClickBlb())
      .catch(() => {})
      .then(() => {
        doubleClickSettingsReady = true;
      });
  }
  return doubleClickSettingsRefreshPromise;
}

void ensureDoubleClickSettingsReady();

// ---------- Floating page selection button ----------
// This feature is intentionally dormant unless the user enables "Show on BLB".
// Alt+B and right-click remain independent entry points.
const BLB_PAGE_BUTTON_ID = 'blb-suite-page-selection-button';
let blbPageButtonSelection = '';
let blbPageButtonContextualReference = null;
let blbPageButtonDirectUrl = null;
let lastSelectionContextualReference = null;
let lastSelectionContextualText = '';
let blbPageButtonVisible = false;
let pageButtonMonitoring = false;
let pageButtonSelectionFrame = 0;
let pageButtonValidationToken = 0;
let pageButtonActionInProgress = false;
let pageButtonDomObserver = null;
let pageButtonDomValidationFrame = 0;

const BLBPageSelectionClassifier = globalThis.BLBPageSelectionClassifierModule.create({
  locationApi:location,
  windowApi:window,
  shared:BLBShared,
  books:BOOKS,
  bookAliases:BOOK_ALIASES,
  normalizeSelectionText,
  canonicalStrongValue,
  resolveBibleReference
});
const { isBlbPageButtonExcludedSite, getSelectedPageText, hasLocalValidBibleReference } = BLBPageSelectionClassifier;

const BLBPageSelectionState = {};
Object.defineProperties(BLBPageSelectionState, {
  'pageButtonDomValidationFrame': {enumerable:true, get:() => pageButtonDomValidationFrame, set:value => { pageButtonDomValidationFrame=value; }},
  'pageButtonDomObserver': {enumerable:true, get:() => pageButtonDomObserver, set:value => { pageButtonDomObserver=value; }},
  'pageButtonMonitoring': {enumerable:true, get:() => pageButtonMonitoring, set:value => { pageButtonMonitoring=value; }},
  'blbPageButtonVisible': {enumerable:true, get:() => blbPageButtonVisible, set:value => { blbPageButtonVisible=value; }},
  'blbPageButtonSelection': {enumerable:true, get:() => blbPageButtonSelection, set:value => { blbPageButtonSelection=value; }},
  'blbPageButtonContextualReference': {enumerable:true, get:() => blbPageButtonContextualReference, set:value => { blbPageButtonContextualReference=value; }},
  'blbPageButtonDirectUrl': {enumerable:true, get:() => blbPageButtonDirectUrl, set:value => { blbPageButtonDirectUrl=value; }},
  'lastSelectionContextualReference': {enumerable:true, get:() => lastSelectionContextualReference, set:value => { lastSelectionContextualReference=value; }},
  'lastSelectionContextualText': {enumerable:true, get:() => lastSelectionContextualText, set:value => { lastSelectionContextualText=value; }},
  'pageButtonSelectionFrame': {enumerable:true, get:() => pageButtonSelectionFrame, set:value => { pageButtonSelectionFrame=value; }},
  'pageButtonActionInProgress': {enumerable:true, get:() => pageButtonActionInProgress, set:value => { pageButtonActionInProgress=value; }},
  'pageButtonValidationToken': {enumerable:true, get:() => pageButtonValidationToken, set:value => { pageButtonValidationToken=value; }},
  'suiteEnabled': {enumerable:true, get:() => suiteEnabled, set:value => { suiteEnabled=value; }}
});
const BLBPageSelectionLifecycle = globalThis.BLBPageSelectionLifecycleModule.create({
  state:BLBPageSelectionState,
  documentApi:document,
  windowApi:window,
  locationApi:location,
  ElementCtor:Element,
  MutationObserverCtor:MutationObserver,
  requestAnimationFrameFn:requestAnimationFrame,
  cancelAnimationFrameFn:cancelAnimationFrame,
  setTimeoutFn:setTimeout,
  buttonId:BLB_PAGE_BUTTON_ID,
  normalizeSelectionText,
  normalizeDoubleClickToken,
  kjvWordIndex:KJV_CORPUS_WORD_INDEX,
  resolveBibleBook,
  resolveBibleReferenceText,
  getContextualBibleReference,
  isSensitiveSiteHostname,
  isBlbPageButtonExcludedSite,
  getSelectedPageText,
  makeBlbMultiVerseButtonDraggable,
  safeRuntimeSendMessage
});
const { stopBlbPageSelectionDomObserver, syncBlbPageSelectionDomObserver, invalidateBlbPageSelectionButton, validateBlbPageSelectionAfterDomMutation, setBlbPageButtonVisible, removeBlbPageSelectionButton, addBlbPageSelectionButton, updateBlbPageSelectionButtonFromSelection, scheduleFinalBlbPageSelectionButtonUpdate, handleBlbPageSelectionMouseDown, handleBlbPageSelectionKeyDown, handleBlbPageSelectionMouseUp, handleBlbPageSelectionKeyUp, enableBlbPageButtonMonitoring, disableBlbPageButtonMonitoring, getPageSelectionSiteKey, clearBlbPageSelectionAfterAction } = BLBPageSelectionLifecycle;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'blbSuiteClearPageSelection') {
    clearBlbPageSelectionAfterAction();
    sendResponse({ok:true});
    return;
  }
  if (message?.type === 'blbSuiteRefreshSiteFeatures') {
    Promise.all([
      refreshBlbPageSelectionButton().catch(()=>{}),
      refreshDoubleClickBlb().catch(()=>{})
    ]).then(() => sendResponse({ok:true})).catch(() => sendResponse({ok:false}));
    return true;
  }
  if (message?.type === 'blbSuiteResolveContextualSelection') {
    try {
      const selected = String(message.selectionText || '').trim();
      const cached = lastSelectionContextualText === selected ? lastSelectionContextualReference : null;
      const resolved = cached || getContextualBibleReference(selected);
      sendResponse(resolved ? {ok:true, reference:resolved} : {ok:true, reference:null});
    } catch (_) { sendResponse({ok:true, reference:null}); }
    return true;
  }
  if (message?.type === 'blbSuiteGetPageSelectionVisibility') {
    sendResponse({visible: !!(suiteEnabled && pageButtonMonitoring && blbPageButtonVisible)});
    return;
  }
  if (message?.type === 'blbSuiteGetActiveSelectionText') {
    try {
      const selection = window.getSelection?.();
      if (!selection || !selection.rangeCount) {
        sendResponse({ok:true, text:''});
        return;
      }
      const range = selection.getRangeAt(0).cloneRange();
      const blockTags = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DIV','DL','DT','DD','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL']);
      const pieces = [];
      const walk = node => {
        if (node.nodeType === Node.TEXT_NODE) { pieces.push(node.nodeValue || ''); return; }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') { pieces.push('\n'); return; }
        const isBlock = node.nodeType === Node.ELEMENT_NODE && blockTags.has(node.tagName);
        if (isBlock && pieces.length && !String(pieces[pieces.length - 1]).endsWith('\n')) pieces.push('\n');
        for (const child of node.childNodes) walk(child);
        if (isBlock && pieces.length && !String(pieces[pieces.length - 1]).endsWith('\n')) pieces.push('\n');
      };
      walk(range.cloneContents());
      const reconstructed = pieces.join('').replace(/\u00a0/g, ' ').replace(/[ \\t]*\n[ \\t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      sendResponse({ok:true, text:reconstructed || selection.toString()});
    } catch (_) {
      sendResponse({ok:true, text:window.getSelection ? window.getSelection().toString() : ''});
    }
    return;
  }
});

async function refreshBlbPageSelectionButton() {
  try {
    if (isBlbPageButtonExcludedSite() || isSensitiveSiteHostname(location.hostname)) {
      disableBlbPageButtonMonitoring();
      return;
    }
    const siteKey = getPageSelectionSiteKey();
    const data = await chrome.storage.local.get({pageSelectionButtonSites:{}});
    const sites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object'
      ? data.pageSelectionButtonSites
      : {};
    const hasExplicitPreference = Object.prototype.hasOwnProperty.call(sites, siteKey);
    // Show on BLB is site-based. An explicit site setting wins; otherwise the
    // hostname/default-sites rule supplies the site's default (ON or OFF).
    const defaultEnabled = await getSiteDefaultEnabled();
    const shouldEnable = hasExplicitPreference ? sites[siteKey] === true : defaultEnabled;
    // Keep the native context-menu item in lockstep with the exact setting that
    // controls the floating Show on BLB button.
    await safeRuntimeSendMessage({type:'blbSuiteSyncSelectionContextMenu'});
    if (!suiteEnabled || !shouldEnable) {
      disableBlbPageButtonMonitoring();
      return;
    }
    enableBlbPageButtonMonitoring();
  } catch (_) {
    // Fail closed if site-feature settings or defaults cannot be read.
    disableBlbPageButtonMonitoring();
    try { await safeRuntimeSendMessage({type:'blbSuiteSyncSelectionContextMenu'}); } catch (_) {}
  }
}

if (!isBlbPageButtonExcludedSite() && !isSensitiveSiteHostname(location.hostname)) {
  suiteSettingsReadyPromise.then(refreshBlbPageSelectionButton).catch(()=>{});
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { refreshBlbPageSelectionButton().catch(()=>{}); }, {once:true});
  } else {
    setTimeout(() => { refreshBlbPageSelectionButton().catch(()=>{}); }, 0);
  }
}


chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.redirectEnabled) {
    theKingsBibleRedirectEnabled = changes.redirectEnabled.newValue === true;
    sourceBibleRedirectEnabled = changes.redirectEnabled.newValue === true;
  }

  if (changes.masterEnabled) {
    suiteEnabled = changes.masterEnabled.newValue !== false;
    if (!suiteEnabled) {
      document.getElementById('blb-suite-webster-multiverse')?.remove();
      document.getElementById('blb-suite-webster-multiverse-reset-position')?.remove();
      document.getElementById('blb-suite-webster-status')?.remove();
      disableBlbPageButtonMonitoring();
    } else {
      if (location.hostname === 'webstersdictionary1828.com') globalThis.BLBWebsterCollector?.ensureButton?.();
      refreshBlbPageSelectionButton();
    }
  }

  if (changes.pageSelectionButtonSites && suiteEnabled) {
    refreshBlbPageSelectionButton();
  }

  if (changes.doubleClickBlbSites) {
    refreshDoubleClickBlb();
  }
});

})();