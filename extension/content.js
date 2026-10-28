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

function normalizeSelectionText(s) {
  return String(s || '')
    // Facebook and some rich-text sites can insert invisible bidirectional
    // formatting marks around Bible references. They are presentation-only
    // characters and must not become part of the reference token.
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(s) {
  return normalizeSelectionText(s).toLowerCase().replace(/[_]/g,"-").replace(/[.]/g,"").replace(/\s+/g,"-").replace(/-+/g,"-");
}
function bookKey(value) {
  const book = resolveBibleBook(value);
  return book ? book.urlKey : null;
}
function decodeSafe(v) {
  try { return decodeURIComponent(String(v||"").replace(/\+/g," ")); }
  catch { return String(v||""); }
}
function blbUrl(book,ch,from=1,to=null) {
  const key=bookKey(book);
  if (!key || !ch) return null;
  const resolved=resolveBibleReference(key,ch,from,to);
  return resolved ? resolved.url : null;
}
function normalizeSourceBibleBook(book) {
  // Normalize common source-site abbreviations before KJV book resolution.
  // Sagacity can expose “Matt. 12:37” in captions and BLB Criteria URLs;
  // the resolver expects the canonical book name “Matthew”.
  const value = String(book || "").trim();
  if (/^Psalm$/i.test(value)) return "Psalms";
  if (/^Matt\.?$/i.test(value)) return "Matthew";
  return book;
}

function formatSourceBibleBookName(book) {
  // BOOKS stores names in lowercase for matching; generated labels need
  // readable book-name casing without capitalizing words such as “of”.
  return String(book || "").split(/\s+/).map((word, index) => {
    if (!word) return word;
    const lower = word.toLowerCase();
    if (index > 0 && (lower === "of" || lower === "the")) return lower;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

function parseRef(text) {
  const value=decodeSafe(text).trim();
  // Accept normal references and BiblePortal's dotted form, e.g.
  // John 3:16, John 3 16, and John.3.16.
  const m=value.match(/^(.+?)[\s.]+(\d+)(?:[:.\s]+(\d+)(?:-(\d+))?)?$/);
  return m ? {book:m[1].trim(),chapter:Number(m[2]),from:m[3]?Number(m[3]):1,to:m[4]?Number(m[4]):null} : null;
}

function validateSourceBibleReference(ref) {
  if (!ref) return null;
  const book = resolveBibleBook(ref.book);
  const chapter = Number(ref.chapter);
  const from = ref.from == null ? 1 : Number(ref.from);
  const to = ref.to == null ? null : Number(ref.to);
  if (!book || !Number.isInteger(chapter) || chapter < 1 || chapter > book.chapterCount ||
      !Number.isInteger(from) || from < 1) return null;
  const maxVerse = book.verses?.[chapter - 1];
  if (!maxVerse || from > maxVerse ||
      (to !== null && (!Number.isInteger(to) || to < from || to > maxVerse))) return null;
  return {book:book.name, chapter, from, to};
}

function parseChristianityBibleLink(href) {
  let url;
  try { url = new URL(href, location.href); } catch (_) { return null; }
  if (url.hostname.toLowerCase().replace(/^www\./, "") !== "christianity.com") return null;
  const match = url.pathname.match(/^\/bible\/[^/]+\/([^/]+)\/(\d+)(?:-(\d+)(?:-(\d+))?)?\/?$/i);
  if (!match) return null;

  const book = resolveBibleBook(match[1].replace(/-/g, " "));
  const chapter = Number(match[2]);
  const from = match[3] ? Number(match[3]) : 1;
  const to = match[4] ? Number(match[4]) : null;
  if (!book || !Number.isInteger(chapter) || chapter < 1 || chapter > book.chapterCount ||
      !Number.isInteger(from)) return null;
  const maxVerse = book.verses?.[chapter - 1];
  if (!maxVerse || (to !== null && (!Number.isInteger(to) || to < from))) return null;
  // Match other source hosts: the shared resolver clamps verse values to the
  // valid chapter boundaries instead of rejecting them here.
  return { book:book.name, chapter, from, to };
}

function christianityBibleLinkTarget(href) {
  const ref = parseChristianityBibleLink(href);
  return ref ? blbUrl(ref.book, ref.chapter, ref.from, ref.to) : null;
}

// Handle passage-click requests raised by the tiny MAIN-world guard.
// The page-world guard can cancel native handlers only after this isolated-world
// resolver confirms that the link maps to a valid KJV passage.
function installChristianityLinkRedirect(isEnabled) {
  window.addEventListener("blb-suite-source-passage-click", event => {
    if (!isEnabled()) return;
    // A string detail crosses Chrome's MAIN/ISOLATED world boundary
    // without exposing a page-owned object to the extension world.
    let detail = null;
    try { detail = JSON.parse(typeof event.detail === "string" ? event.detail : ""); } catch (_) {}
    const href = typeof detail?.href === "string" ? detail.href : "";
    const label = String(typeof detail?.label === "string" ? detail.label : "").replace(/\s+/g, " ").trim();
    const host = String(location.hostname || "").toLowerCase().replace(/^www\./, "");
    let target = christianityBibleLinkTarget(href);
    if (!target && ["crosswalk.com", "enduringword.com", "gotquestions.org"].includes(host)) {
      const cleanLabel = label.replace(/\s*\((?:KJV|NKJV|ESV|NIV|NASB|CSB|NLT|WEB|AMP|RSV|ASV)\)\s*$/i, "").trim();
      const parsed = parseRef(cleanLabel);
      if (parsed) target = blbUrl(parsed.book, parsed.chapter, parsed.from, parsed.to);
    }
    if (!target) return;
    // Cancel the custom request synchronously so the MAIN-world click guard
    // knows it may also cancel the original click and its native site handlers.
    event.preventDefault();
    openBlbDestinationFromContent(target);
  }, true);
}

const redirectBibleSite = globalThis.BLBSourceBibleRedirectModule.initialize({
  BLBShared,
  BOOKS,
  bookKey,
  parseChristianityBibleLink,
  validateSourceBibleReference,
  parseRef,
  decodeSafe,
  blbUrl,
  openBlbDestinationFromContent
});

// On The King's Bible Dictionary/Concordance pages, keep the source page open.
// Only clicked Bible-passage and Strong's links are sent to BLB in a new tab.
let theKingsBibleRedirectEnabled = false;
if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get({redirectEnabled:false}).then(data => {
    theKingsBibleRedirectEnabled = data.redirectEnabled === true;
  }).catch(() => {});
}

function theKingsBibleLinkTarget(href) {
  let url;
  try { url = new URL(href, location.href); } catch (_) { return null; }
  if (url.hostname.toLowerCase().replace(/^www\./, "") !== "thekingsbible.com") return null;
  const path = url.pathname.replace(/\/{2,}/g, "/");
  let match = path.match(/^\/StrongsNo\/([GH])0*(\d+)\/?$/i);
  if (match) {
    const language = match[1].toLowerCase();
    return `${BLBShared.urls.blbOrigin}/lexicon/${language}${Number(match[2])}/kjv/${language === "h" ? "wlc" : "tr"}/0-1/`;
  }
  match = path.match(/^\/Bible\/(\d+)\/(\d+)\/?$/i);
  if (match) {
    const book = BOOKS.find(item => Number(item.bookNumber) === Number(match[1]));
    if (!book) return null;
    const verseParam = url.searchParams.get("verse");
    const verse = verseParam && /^\d+$/.test(verseParam) ? Number(verseParam) : 1;
    return blbUrl(book.name, Number(match[2]), verse);
  }
  return null;
}

if (location.hostname?.toLowerCase().replace(/^www\./, "") === "thekingsbible.com" &&
    /^\/(?:dictionary|concordance)\//i.test(location.pathname.replace(/\/{2,}/g, "/"))) {
  document.addEventListener("click", event => {
    if (event.defaultPrevented || isModifiedLinkActivation(event)) return;
    if (!theKingsBibleRedirectEnabled || !suiteEnabled) return;

    // Only Dictionary pages are known to use the .bible[data-bible]
    // markup. Keep this source-specific decoder off Concordance pages.
    const isDictionaryPage = /^\/dictionary\//i.test(location.pathname.replace(/\/{2,}/g, "/"));
    const bibleReference = isDictionaryPage
      ? event.target?.closest?.(".bible[data-bible]")
      : null;
    if (bibleReference) {
      const label = String(bibleReference.textContent || "").trim();
      const encoded = String(bibleReference.getAttribute("data-bible") || "");
      let resolved = null;

      // A complete visible label is the most reliable source for the book.
      // Some Dictionary references list non-contiguous verses as "2 Samuel 15;24,29,35,36".
      // BLB URLs support a single verse or a continuous range, so use the first listed verse.
      for (const book of BOOKS) {
        const prefix = String(book.name) + " ";
        if (!label.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const referenceText = label.slice(prefix.length).trim();

        // Textual data-bible values can list non-contiguous verses, e.g.
        // "2 Samuel 15;24,29,35,36". Send all listed verses to BLB MultiVerse.
        const listMatch = referenceText.match(/^(\d+);(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
        if (listMatch) {
          const chapter = Number(listMatch[1]);
          const verseItems = listMatch[2].split(",");
          const refs = [];
          for (const item of verseItems) {
            const verseMatch = item.match(/^(\d+)(?:-(\d+))?$/);
            if (!verseMatch) { refs.length = 0; break; }
            const verse = Number(verseMatch[1]);
            const verseEnd = verseMatch[2] ? Number(verseMatch[2]) : verse;
            const reference = resolveBibleReference(book.name, chapter, verse, verseEnd);
            if (!reference) { refs.length = 0; break; }
            refs.push({
              book: reference.book.name,
              bookNumber: Number(reference.book.bookNumber),
              chapter: reference.chapter,
              from: reference.from,
              to: reference.to,
              version: "kjv"
            });
          }
          if (chapter > 0 && refs.length === verseItems.length && refs.length > 1) {
            event.preventDefault();
            event.stopImmediatePropagation();
            chrome.runtime.sendMessage({type: "blbSuiteOpenWebsterMultiVerse", refs}).catch(() => {});
            return;
          }
        } else {
          const match = referenceText.match(/^(\d+)(?:[:;](\d+)(?:-(\d+))?)?$/);
          if (match) {
            const chapter = Number(match[1]);
            const verse = match[2] ? Number(match[2]) : 1;
            const verseEnd = match[3] ? Number(match[3]) : null;
            if (chapter > 0 && verse > 0 && (verseEnd === null || verseEnd >= verse)) {
              resolved = blbUrl(book.name, chapter, verse, verseEnd);
            }
          }
        }
        break;
      }

      // For abbreviated labels such as "13:1", decode the data-bible ID.
      if (!resolved && /^\d{7,8}$/.test(encoded)) {
        const bookCode = encoded.slice(0, -6);
        const chapter = Number(encoded.slice(-6, -3));
        const verse = Number(encoded.slice(-3));
        // Observed dictionary IDs use source-specific code 65 for Judges
        // (e.g. 65003003 = Judges 3:3); other observed codes match KJV numbers.
        const book = bookCode === "65"
          ? BOOKS.find(item => item.name.toLowerCase() === "judges")
          : BOOKS.find(item => Number(item.bookNumber) === Number(bookCode));
        // Dictionary entries may put the book name in a preceding tag and
        // leave only a range such as "17:15-17" in this .bible span.
        // Use data-bible for book/chapter/start verse and preserve the visible end.
        const visibleRange = label.match(/^(\d+):(\d+)-(\d+)$/);
        if (book && chapter > 0 && verse > 0) {
          if (
            visibleRange &&
            Number(visibleRange[1]) === chapter &&
            Number(visibleRange[2]) === verse &&
            Number(visibleRange[3]) >= verse
          ) {
            resolved = blbUrl(book.name, chapter, verse, Number(visibleRange[3]));
          } else {
            resolved = blbUrl(book.name, chapter, verse);
          }
        }
      }

      if (resolved) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openBlbDestinationFromContent(resolved);
        return;
      }
    }

    // Some dictionary/concordance references and Strong's numbers are anchors.
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    const target = theKingsBibleLinkTarget(anchor.href);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openBlbDestinationFromContent(target);
  }, true);
}

function redirectBlbNet() {
  if (location.hostname.toLowerCase() !== BLBShared.hostnames.blbWww) return false;

  // BLB passage URLs may appear as /<version>/<book>/<chapter>/<verse>/
  // or include the optional /s_<id> suffix. This is BLB URL syntax, separate
  // from ScriptTagger/reference text syntax. Keep KJV native; redirect other
  // translation passage URLs to the equivalent KJV passage.
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)(?:-(\d+))?(?:\/s_\d+)?\/?$/i);
  if (!m || m[1].toLowerCase() === "kjv") return false;

  const book = m[2].toLowerCase();
  const chapter = m[3];
  const verse = m[4];
  const endVerse = m[5] ? "-" + m[5] : "";
  const target = `${BLBShared.urls.blbHome}kjv/${book}/${chapter}/${verse}${endVerse}/`;
  location.replace(target);
  return true;
}

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
if (["christianity.com", "gotquestions.org", "crosswalk.com", "enduringword.com"].includes(location.hostname.toLowerCase().replace(/^www\./, ""))) {
  installChristianityLinkRedirect(() => suiteEnabled && sourceBibleRedirectEnabled);
}

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
// The MultiVerse copy enhancement module is loaded before this content script.
globalThis.BLBMultiVerseCopyModule?.initialize({
  BLBShared,
  resolveBibleBook,
  isSuiteEnabled: () => suiteEnabled
});

// Auto Hyperlinker behavior is isolated in a classic-script feature module.
globalThis.BLBAutoHyperlinkerModule?.initialize({
  BLBShared,
  isSuiteEnabledNow: () => suiteEnabled,
  isSuiteEnabled
});

// BLB parsing-popup navigation remains an independent feature module.
if (location.hostname.endsWith(BLB_HOSTNAME) &&
    !/(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)) {
  globalThis.BLBParsePopupModule?.initialize({
    BLB_HOSTNAME,
    BLBShared,
    isSuiteEnabledNow: () => suiteEnabled,
    isModifiedLinkActivation,
    openBlbDestinationFromContent
  });
}

// BLB verse-link navigation is isolated in a classic-script feature module.
globalThis.BLBVerseLinkNavigationModule?.initialize({
  BLB_HOSTNAME,
  isSuiteEnabledNow: () => suiteEnabled,
  isModifiedLinkActivation,
  openBlbDestinationFromContent
});

// BLB MultiVerse tool-page navigation is isolated in a classic-script feature module.
globalThis.BLBMultiVerseToolViewModule?.initialize({
  BLB_HOSTNAME,
  isSuiteEnabledNow: () => suiteEnabled,
  isModifiedLinkActivation,
  safeRuntimeSendMessage
});

// Criteria Search navigation is isolated in a classic-script feature module.
globalThis.BLBCriteriaSearchNavigationModule?.initialize({
  BLB_HOSTNAME,
  isSuiteEnabledNow: () => suiteEnabled,
  isModifiedLinkActivation,
  openBlbDestinationFromContent
});

// Passive BLB new-tab targets are isolated in a classic-script feature module.
globalThis.BLBPassiveNewTabTargetsModule?.initialize({
  BLB_HOSTNAME,
  isSuiteEnabledNow: () => suiteEnabled
});

// Shared floating-button drag behavior is isolated in a classic-script feature module.
const makeBlbMultiVerseButtonDraggable = globalThis.BLBDraggableButtonModule?.makeBlbMultiVerseButtonDraggable;

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

// The source-page collector module is loaded before this content script.
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

// MultiVerse hand-off runs as a dedicated feature module.
globalThis.BLBMultiVerseHandoffModule?.initialize({
  BLBShared,
  isSuiteEnabled,
  resolveBibleBook
});


// Study capture is isolated in a classic-script feature module.
globalThis.BLBStudyReferenceCaptureModule?.initialize({
  BLB_HOSTNAME,
  normalizeSelectionText,
  isSuiteEnabled
});

// ---------- Double-Click BLB ----------
// Double-click a single KJV word, Bible book name, or standalone book number.
// Uses the Suite's own selection logic and never invokes BLB's native search.
function normalizeDoubleClickToken(value) {
  return String(value || '').trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase();
}

// ---------- Context-aware Bible reference resolver ----------
// This resolver is intentionally local and tightly gated. It looks only at a
// small text block surrounding the current selection, and only when the
// selected token is a recognized book/alias or a plausible chapter/verse
// number. It reuses the same book aliases already used by the Omnibox.
function getAdjacentBoundaryText(direction, maxChars = 220) {
  try {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
    const range = sel.getRangeAt(0);
    const root = document.body || document.documentElement;
    if (!root) return '';
    const scratch = document.createRange();
    scratch.selectNodeContents(root);
    if (direction === 'before') {
      scratch.setEnd(range.startContainer, range.startOffset);
      return normalizeSelectionText(scratch.toString()).slice(-Math.max(1, Number(maxChars) || 220));
    }
    scratch.setStart(range.endContainer, range.endOffset);
    return normalizeSelectionText(scratch.toString()).slice(0, Math.max(1, Number(maxChars) || 220));
  } catch (_) {
    return '';
  }
}

function getSelectionContextPosition() {
  try {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const block = node?.closest?.('p,li,td,th,blockquote,article,section,div') || node;
    if (!block) return null;

    // Do not mix Range.toString() offsets with block.textContent offsets.
    // Rich Bible pages frequently use nested spans, <br>, bidi marks, or
    // generated citation elements, and those two representations can have
    // different lengths. Build the context from the same Range API used to
    // locate the selection, so a partial selection such as `1-6`, `150`, or
    // `16` always maps to the correct complete reference.
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(block);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = document.createRange();
    afterRange.selectNodeContents(block);
    afterRange.setStart(range.endContainer, range.endOffset);
    // Normalize each segment separately so the selection offsets stay aligned
    // with the normalized context string. Normalizing only after concatenation
    // would collapse whitespace before the selected text and shift its offsets.
    // Range.toString() omits the visible boundary represented by <br> in
    // Chromium. Instagram captions use <br> extensively, so a plain range
    // string can concatenate unrelated sentences and references (for example
    // "Psalm 102:20 ... Psalm 38:11-14"). Clone the range and serialize its DOM
    // structure, converting line breaks and block boundaries into whitespace.
    // Use the same serializer for all three segments so selection offsets remain
    // aligned with the context that the reference resolver actually receives.
    const rangeText = sourceRange => {
      const fragment = sourceRange.cloneContents();
      const pieces = [];
      const walk = current => {
        for (const child of current.childNodes || []) {
          if (child.nodeType === Node.TEXT_NODE) {
            pieces.push(child.nodeValue || '');
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName;
            if (tag === 'BR') {
              pieces.push(' ');
              continue;
            }
            const blockLike = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/.test(tag);
            if (blockLike && pieces.length && !/\\s$/.test(pieces[pieces.length - 1])) pieces.push(' ');
            walk(child);
            if (blockLike && pieces.length && !/^\\s/.test(pieces[pieces.length - 1])) pieces.push(' ');
          }
        }
      };
      walk(fragment);
      return pieces.join('');
    };
    const before = normalizeSelectionText(rangeText(beforeRange));
    const selected = normalizeSelectionText(rangeText(range));
    const after = normalizeSelectionText(rangeText(afterRange));
    if (!selected) return null;

    // Normalize segments independently, then preserve a separator between
    // each segment. This keeps citations intact when only a word or number is
    // selected inside a nested span, while <br> keeps adjacent citations apart.
    const prefix = before ? before + ' ' : '';
    const suffix = after ? ' ' + after : '';
    const start = prefix.length;
    return { text: prefix + selected + suffix, start, end: start + selected.length };
  } catch (_) { return null; }
}

function resolveBibleReferenceFromContextWindow(text, selectionStart, selectionEnd) {
  const source = normalizeSelectionText(text);
  if (!source) return null;
  // A same-chapter comma-separated list is one contextual citation for
  // double-click purposes. Any part of the citation (book, chapter, first
  // verse, comma, or continuation verse) opens the consecutive range.
  // Separate comma continuations such as "Psalms 1:2, 105:1" still use the
  // exact selected-token rule below.
  const verseListRe = /((?:[1-3]\s*|i{1,3}\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)\s*:\s*(\d+(?:\s*,\s*\d+)+)/gi;
  let verseListMatch;
  while ((verseListMatch = verseListRe.exec(source))) {
    const book = resolveBibleBook(verseListMatch[1]);
    if (!book) continue;
    const citationStart = verseListMatch.index;
    const citationEnd = citationStart + verseListMatch[0].length;
    const overlapsCitation = selectionStart < citationEnd && selectionEnd > citationStart;
    if (!overlapsCitation) continue;

    const verses = verseListMatch[3].split(',').map(value => Number(value.trim()));
    if (verses.some((verse, index) => index > 0 && verse !== verses[index - 1] + 1)) continue;
    const chapter = Number(verseListMatch[2]);
    const resolved = resolveBibleReference(book.name, chapter, verses[0], verses[verses.length - 1]);
    if (resolved) return {book:resolved.book,chapter:resolved.chapter,from:resolved.from,to:resolved.to,url:resolved.url};
  }

  // Keep exact-token behavior for other comma continuations, e.g.
  // "Psalms 1:2, 105:1" -> selecting 105 means Psalm 105:1.
  const commaContinuationRe = /((?:[1-3]\s*|i{1,3}\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)\s*:\s*(\d+)\s*,\s*(\d+)(?:\s*:\s*(\d+))?/gi;
  let commaMatch;
  while ((commaMatch = commaContinuationRe.exec(source))) {
    const secondNumberStart = commaMatch.index + commaMatch[0].lastIndexOf(commaMatch[4]);
    const secondNumberEnd = secondNumberStart + commaMatch[4].length;
    if (selectionStart < secondNumberStart || selectionEnd > secondNumberEnd) continue;
    const book = resolveBibleBook(commaMatch[1]);
    if (!book) continue;
    const chapter = commaMatch[5] ? Number(commaMatch[4]) : Number(commaMatch[2]);
    const verse = commaMatch[5] ? Number(commaMatch[5]) : Number(commaMatch[4]);
    const resolved = resolveBibleReference(book.name, chapter, verse, verse);
    if (resolved) return {book:resolved.book,chapter:resolved.chapter,from:resolved.from,to:resolved.to,url:resolved.url};
  }

  const refs = resolveBibleReferenceText(source);
  const candidates = [];

  // A reference can occur more than once in the context block. Find the
  // occurrence that actually contains/touches the user's selection rather
  // than trusting source.indexOf(ref.text), which can select an earlier or
  // unrelated duplicate. This is especially important when the selected
  // verse number is at the end of a line immediately before another
  // reference such as "Hosea ...".
  for (const ref of refs) {
    const needle = String(ref.text || '');
    if (!needle) continue;
    let fromIndex = 0;
    while (fromIndex <= source.length) {
      const refStart = source.indexOf(needle, fromIndex);
      if (refStart < 0) break;
      const refEnd = refStart + needle.length;
      const overlaps = selectionStart < refEnd && selectionEnd > refStart;
      const touches = selectionStart === refEnd || selectionEnd === refStart;
      if (overlaps || touches) {
        const distance = overlaps ? 0 : Math.min(
          Math.abs(selectionStart - refEnd),
          Math.abs(selectionEnd - refStart)
        );
        candidates.push({ ref, distance, length: needle.length, start: refStart });
      }
      fromIndex = refStart + Math.max(1, needle.length);
    }
  }

  candidates.sort((a, b) =>
    a.distance - b.distance ||
    b.length - a.length ||
    a.start - b.start
  );
  const winner = candidates[0]?.ref;
  if (!winner) return null;
  return {
    book: winner.book,
    chapter: winner.chapter,
    from: winner.from,
    to: winner.to,
    url: winner.url
  };
}

function getContextualBibleReference(selectionText) {  const selected = normalizeSelectionText(selectionText);
  if (!selected) return null;

  // There is one contextual-reference parser. It receives text reconstructed
  // from either the DOM selection boundaries or the immediate text around
  // those boundaries, then delegates all book/number interpretation to the
  // shared reference core. No separate strict/legacy/alias parser is allowed
  // to override this result.
  // Prefer the exact DOM Range context first. The broad before/after window
  // can contain other Bible references, and a short token such as "Jn" or
  // "16" may occur in more than one reference in that window. The Range gives
  // us the actual clicked occurrence, so it must be authoritative whenever
  // the browser exposes a usable selection.
  const position = getSelectionContextPosition();
  if (position?.text) {
    const resolved = resolveBibleReferenceFromContextWindow(position.text, position.start, position.end);
    if (resolved) return resolved;
  }

  // Do not fall back to document/body-wide text when the browser has not
  // exposed stable Range boundaries yet. That can borrow a Bible reference
  // from a different line, heading, paragraph, or unrelated section and turn
  // a standalone token into an unrelated destination. The dblclick handler
  // already has a block-local fallback (getDoubleClickBlockContextReference)
  // and waits briefly for the native selection to settle.
  return null;
}

function getStandaloneBookReference(selectionText) {
  try {
    const selected = normalizeSelectionText(selectionText);
    if (!selected || !/^(?:[1-9]|[1-5][0-9]|6[0-6]|[A-Za-z][A-Za-z0-9 .'-]*)$/.test(selected)) return null;

    // Standalone 1-66 is a numeric-book gesture. Resolve it from the
    // authoritative BOOKS table rather than treating the number as a textual
    // book name; reference parsing remains responsible for contextual numbers.
    const book = Array.isArray(BOOKS)
      ? BOOKS.find(candidate => String(candidate.bookNumber) === selected)
      : null;
    if (!book) return null;

    const urlKey = String(book.urlKey || '').trim();
    if (!urlKey) return null;

    return {
      book: book.name,
      chapter: 1,
      from: 1,
      to: 1,
      url: `${BLBShared.urls.blbHome}kjv/${urlKey}/1/1/`
    };
  } catch (_) {
    return null;
  }
}

function isBibleVersionCodeToken(value) {
  // Double-click selection may include surrounding punctuation when the
  // version label is wrapped in parentheses/brackets or followed by a comma,
  // dash, or sentence punctuation. Normalize only the token edges so the
  // version-code boundary guard still applies to those common forms.
  const token = normalizeSelectionText(value).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return /^(?:KJV|NKJV|NIV|NIVUK|ESV|NASB|NASB95|NASB2020|LSB|NLT|CSB|HCSB|RSV|NRSV|NRSVUE|ASV|AMP|AMPC|NET|WEB|YLT|DARBY|BBE|WYC|TLB|MSG|GNT|NIRV|CEV|ISV|LEB|ERV|GW|ICB|NCV|NABRE|NJB|JPS|MEV|KJ21|AKJV|VOICE|PHILLIPS|TPT)$/i.test(token);
}

function getDoubleClickBlockContextReference(selectionText, target, event = null) {
  try {
    // textContent and Range.toString() omit <br> boundaries. Instagram captions
    // use <br> inside a single inline container, so preserve those boundaries
    // when building both the reference text and the offsets used to match it.
    const serializeDomChildren = root => {
      const pieces = [];
      const walk = current => {
        for (const child of current.childNodes || []) {
          if (child.nodeType === Node.TEXT_NODE) pieces.push(child.nodeValue || '');
          else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName;
            if (tag === 'BR') { pieces.push(' '); continue; }
            const blockLike = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/.test(tag);
            if (blockLike && pieces.length && !/\s$/.test(pieces[pieces.length - 1])) pieces.push(' ');
            walk(child);
            if (blockLike && pieces.length && !/^\s/.test(pieces[pieces.length - 1])) pieces.push(' ');
          }
        }
      };
      walk(root);
      return pieces.join('');
    };
    const domText = element => serializeDomChildren(element);
    const domRangeText = range => serializeDomChildren(range.cloneContents());
    let selected = normalizeSelectionText(selectionText).normalize('NFKC');
    const initialNode = target instanceof Element ? target : (target?.parentElement || null);

    // Prefer the physical double-click location over the browser's Selection:
    // dblclick can expose a stale, non-empty Selection from the previous word.
    // Resolve the caret's text node and expand to the actual word token so the
    // citation matcher uses one consistent source of position and token text.
    let clickedWordRange = null;
    let clickedWordText = '';
    try {
      if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
        let pointRange = null;
        if (typeof document.caretRangeFromPoint === 'function') {
          pointRange = document.caretRangeFromPoint(event.clientX, event.clientY);
        } else if (typeof document.caretPositionFromPoint === 'function') {
          const position = document.caretPositionFromPoint(event.clientX, event.clientY);
          if (position?.offsetNode) {
            pointRange = document.createRange();
            pointRange.setStart(position.offsetNode, position.offset);
            pointRange.collapse(true);
          }
        }
        // caretRangeFromPoint may return an element boundary on some rich-text
        // sites instead of a text-node boundary. Convert that boundary to the
        // nearest text node at the physical click before expanding the word.
        let textNode = pointRange?.startContainer || null;
        let pointOffset = pointRange?.startOffset ?? 0;
        if (textNode?.nodeType === Node.ELEMENT_NODE) {
          const children = textNode.childNodes || [];
          const right = children[Math.min(pointOffset, children.length)] || null;
          const left = pointOffset > 0 ? children[pointOffset - 1] : null;
          const findText = (root, fromEnd = false) => {
            if (!root) return null;
            if (root.nodeType === Node.TEXT_NODE && (root.nodeValue || '').length) return root;
            const descendants = [...(root.childNodes || [])];
            if (fromEnd) descendants.reverse();
            for (const child of descendants) {
              const found = findText(child, fromEnd);
              if (found) return found;
            }
            return null;
          };
          const rightText = findText(right);
          const leftText = findText(left, true);
          if (rightText) {
            textNode = rightText;
            pointOffset = 0;
          } else if (leftText) {
            textNode = leftText;
            pointOffset = (leftText.nodeValue || '').length;
          } else {
            textNode = null;
          }
        }
        if (textNode?.nodeType === Node.TEXT_NODE) {
          const value = textNode.nodeValue || '';
          pointOffset = Math.max(0, Math.min(value.length, pointOffset));
          const isWordChar = char => /[A-Za-z0-9.'’\u2019\u2010-\u2015\u2212-]/.test(char || '');
          let wordStart = pointOffset;
          let wordEnd = pointOffset;
          while (wordStart > 0 && isWordChar(value[wordStart - 1])) wordStart--;
          while (wordEnd < value.length && isWordChar(value[wordEnd])) wordEnd++;
          // Caret APIs can place the caret just after a token with a trailing
          // boundary. If needed, step left into the word under the click.
          if (wordEnd === wordStart && pointOffset > 0 && isWordChar(value[pointOffset - 1])) {
            wordStart = pointOffset - 1;
            wordEnd = pointOffset;
            while (wordStart > 0 && isWordChar(value[wordStart - 1])) wordStart--;
            while (wordEnd < value.length && isWordChar(value[wordEnd])) wordEnd++;
          }
          if (wordEnd > wordStart) {
            clickedWordRange = document.createRange();
            clickedWordRange.setStart(textNode, wordStart);
            clickedWordRange.setEnd(textNode, wordEnd);
            clickedWordText = normalizeSelectionText(clickedWordRange.toString()).normalize('NFKC');
            if (clickedWordText) selected = clickedWordText;
          }
        }
      }
    } catch (_) {}

    // Chromium can report an empty/whitespace native selection immediately
    // after an isolated-token double-click. Recover the exact clicked token
    // before doing any positional reference matching; never substitute the
    // whole paragraph, because that would allow unrelated references to leak
    // into an orphan token.
    if (!selected) {
      const candidates = [
        initialNode?.closest?.('[data-index], .reference-token') || initialNode,
        (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY))
          ? document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-index], .reference-token')
          : null
      ];
      for (const candidate of candidates) {
        if (!(candidate instanceof Element)) continue;
        const candidateText = normalizeSelectionText(candidate.textContent || '').normalize('NFKC');
        if (candidateText && !/\s/.test(candidateText)) {
          selected = candidateText;
          break;
        }
      }
    }
    if (!selected) return null;

    // Cross-site article/post-level "verse N" context. Keep the scan inside
    // the nearest recognizable content root instead of depending on Facebook's
    // private DOM attributes; this supports articles, Substack posts, and other
    // sites while avoiding a whole-document scan on pages with unrelated refs.
    const messageRoot = initialNode?.closest?.(
      '[data-ad-comet-preview="message"], [role="article"], article, main, [role="main"], ' +
      '[itemprop="articleBody"], .dt-post-body, .available-content, .post-content, ' +
      '.entry-content, .article-body, .article-content, .content-body'
    ) || initialNode?.closest?.('article, main, [role="main"]');
    if (messageRoot) {
      // Coordinate-based caret APIs can occasionally resolve against a nearby
      // overlay or a stale layout position. Accept that range only when it is
      // actually inside this message; otherwise fall back to a matching live
      // selection rooted in the same message instead of letting an unrelated
      // range suppress the Facebook context resolver.
      const clickRange = (clickedWordRange && messageRoot.contains(clickedWordRange.startContainer))
        ? clickedWordRange
        : (() => {
          const liveSelection = window.getSelection?.();
          if (!liveSelection?.rangeCount || liveSelection.isCollapsed) return null;
          const liveText = normalizeSelectionText(liveSelection.toString()).normalize('NFKC').toLowerCase();
          const targetText = normalizeSelectionText(clickedWordText || initialNode?.textContent || '').normalize('NFKC').toLowerCase();
          // Never use a non-empty selection left behind by a prior double-click
          // as the location of the current gesture.
          if (targetText && !/\s/.test(targetText) && liveText !== targetText) return null;
          const range = liveSelection.getRangeAt(0);
          return messageRoot.contains(range.startContainer) ? range : null;
        })();
      // Facebook may expose a stale or out-of-message Selection after a
      // double-click. If the physical target is the exact verse token, its
      // element boundary is sufficient to resolve the adjacent number and
      // earlier chapter context; do not require a caret range in that case.
      const hasClickRange = !!(clickRange && messageRoot.contains(clickRange.startContainer));
      const clickedElementText = normalizeSelectionText(initialNode?.textContent || '').normalize('NFKC');
      const clickedElementToken = clickedElementText && !/\s/.test(clickedElementText) ? clickedElementText : '';
      // Treat the common abbreviated cue "v." like "v", while keeping the
      // context scan restricted to an exact standalone cue token.
      const normalizedElementToken = normalizeDoubleClickToken(clickedElementToken);
      const normalizedSelectedToken = normalizeDoubleClickToken(clickedWordText || clickedElementToken || selected);
      const clickToken = /^(?:v|verse|verses)$/i.test(normalizedElementToken)
        ? normalizedElementToken
        : normalizedSelectedToken;
      // Only an explicit verse cue may trigger post-level context scanning.
      // Numeric clicks stay on the normal resolver path to avoid expensive
      // book/chapter searches for ordinary numbers.
      const verseWordClick = /^(?:v|verse|verses)$/i.test(clickToken);
      const tokenElementIsExact = !!(initialNode && messageRoot.contains(initialNode) &&
        normalizedElementToken === clickToken);
      if (verseWordClick) {
        messageRoot.setAttribute('data-blb-verse-context-diagnostic', JSON.stringify({
          clickToken, verseWordClick, associatedVerse: null,
          tokenElementIsExact, hasClickRange,
          stage: 'cue-detected-before-range-check'
        }));
      }
      if (hasClickRange || tokenElementIsExact) {
        const beforeRange = document.createRange();
        beforeRange.selectNodeContents(messageRoot);
        if (tokenElementIsExact) beforeRange.setEndBefore(initialNode);
        else beforeRange.setEnd(clickRange.startContainer, clickRange.startOffset);
        const beforeText = normalizeSelectionText(domText(beforeRange.cloneContents())).normalize('NFKC');
        let associatedVerse = null;
        let followingVerse = null;
        if (verseWordClick) {
          const afterRange = document.createRange();
          afterRange.selectNodeContents(messageRoot);
          if (tokenElementIsExact) afterRange.setStartAfter(initialNode);
          else afterRange.setStart(clickRange.endContainer, clickRange.endOffset);
          const afterText = normalizeSelectionText(domText(afterRange.cloneContents())).normalize('NFKC');
          const following = afterText.match(/^[\s,.:;()\[\]{}–—-]*(\d{1,3})\b/);
          followingVerse = following ? Number(following[1]) : null;
          // Never classify an out-of-range number as an extracted verse.
          // Preserve it separately only so the gesture can be explicitly
          // rejected instead of falling through to ordinary word lookup.
          if (Number.isInteger(followingVerse) && followingVerse >= 1 && followingVerse <= 176) {
            associatedVerse = followingVerse;
          }
        }
        if (verseWordClick) {
          const diagnostic = {
            clickToken, verseWordClick, associatedVerse,
            followingVerse,
            tokenElementIsExact, hasClickRange,
            beforeText: beforeText.slice(-500)
          };
          messageRoot.setAttribute('data-blb-verse-context-diagnostic', JSON.stringify(diagnostic));
        }
        if (verseWordClick && associatedVerse) {
          // The first number immediately following the clicked cue is the
          // verse. Do not search for other verse numbers in the post. Resolve
          // chapter context by walking backward from the cue and stop at the
          // nearest valid explicit reference (including chapter-only forms).
          const contextText = beforeText.replace(/[\u2010-\u2015\u2212]/g, '-');
          const entries = [];
          const seenNames = new Set();
          const addBookName = (name, book) => {
            const value = String(name || '').trim();
            const key = value.toLowerCase();
            if (!value || !book || seenNames.has(key)) return;
            seenNames.add(key);
            entries.push({name: value, book});
          };
          for (const book of BOOKS) {
            addBookName(book.name, book);
            addBookName(book.urlKey, book);
          }
          for (const [alias, target] of Object.entries(BOOK_ALIASES)) {
            const book = BOOKS.find(candidate => candidate.name === target);
            if (book) addBookName(alias, book);
          }
          entries.sort((a, b) => b.name.length - a.name.length);
          const candidates = [];
          for (const entry of entries) {
            const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
            const pattern = new RegExp(
              `(?:^|[^A-Za-z0-9])${escaped}\\.?\\s+(\\d{1,3})(?:(?::|\\.)\\s*(\\d{1,3}))?(?=$|[^A-Za-z0-9])`,
              'gi'
            );
            let match;
            while ((match = pattern.exec(contextText)) !== null) {
              const chapter = Number(match[1]);
              if (!Number.isInteger(chapter) || chapter < 1) continue;
              if (!resolveBibleReference(entry.book.name, chapter, 1, 1)) continue;
              candidates.push({index: match.index, book: entry.book.name, chapter});
            }
          }
          // Use only the closest valid book/chapter match before the cue.
          candidates.sort((a, b) => b.index - a.index);
          const context = candidates.length
            ? {book: candidates[0].book, chapter: candidates[0].chapter}
            : null;
          const priorReferences = [];
          const resolved = context
            ? resolveBibleReference(context.book, context.chapter, associatedVerse, associatedVerse)
            : null;
          const resolutionDiagnostic = {
            associatedVerse, context, priorReferences,
            resolvedUrl: resolved?.url || null
          };
          messageRoot.setAttribute('data-blb-verse-context-resolution', JSON.stringify(resolutionDiagnostic));
          if (context) {
            if (resolved) return {
              book: resolved.book,
              chapter: resolved.chapter,
              from: resolved.from,
              to: resolved.to,
              url: resolved.url
            };
          }
        }
      }
    }

    const node = initialNode || document.documentElement;

    // Version-code clicks must resolve only inside the clicked word's nearest
    // content block. The event target can be a broad wrapper (for example, a
    // DIV containing multiple paragraphs), so do not begin the search from that
    // wrapper or inspect its ancestors. Prefer the actual clicked text range.
    const isVersionCodeClick = isBibleVersionCodeToken(selected);
    const blockCandidates = [];
    if (isVersionCodeClick) {
      const clickAnchor = clickedWordRange?.startContainer?.parentElement || initialNode;
      const localBlock = clickAnchor?.closest?.('p,li,td,th,blockquote,article,section,main')
        || clickAnchor?.closest?.('div')
        || (clickAnchor instanceof Element ? clickAnchor : null);
      if (localBlock) blockCandidates.push(localBlock);
    } else {
      // Preserve the established ancestor search for other contextual tokens.
      let candidateNode = node;
      let candidateDepth = 0;
      while (candidateNode && candidateDepth < 32) {
        if (candidateNode instanceof Element) blockCandidates.push(candidateNode);
        candidateNode = candidateNode.parentElement;
        candidateDepth++;
      }
    }

    let block = null;
    for (const candidate of blockCandidates) {
      const candidateRaw = domText(candidate);
      const candidateSource = normalizeSelectionText(candidateRaw).normalize('NFKC');
      // Normalize typographic dashes for source-to-parser matching. Each dash
      // maps to one code unit, so DOM selection offsets remain unchanged.
      const candidateMatchSource = candidateSource.replace(/[\u2010-\u2015\u2212]/g, '-');
      if (!candidateSource) continue;
      // Parse the same dash-normalized text used for positional matching;
      // otherwise Unicode ranges such as 46–47 are located correctly but
      // rejected by the reference parser before matching can begin.
      const candidateRefs = resolveBibleReferenceText(candidateMatchSource);
      if (!candidateRefs.length) continue;

      let start = null;
      let end = null;
      const normalizedOffset = (rawText, offset) => {
        const bounded = Math.max(0, Math.min(rawText.length, offset));
        const prefix = rawText.slice(0, bounded);
        const normalizedPrefix = normalizeSelectionText(prefix).normalize('NFKC');
        // Prefix normalization trims trailing whitespace; restore one space
        // when it separates this prefix from the next visible token.
        const separator = normalizedPrefix.length > 0 &&
          bounded < rawText.length &&
          /[\s\u00A0\u2007\u202F]$/.test(prefix) &&
          /\S/.test(rawText.slice(bounded));
        return normalizedPrefix.length + (separator ? 1 : 0);
      };
      try {
        const contextualTarget = getDoubleClickTargetElement(event) || initialNode;
        if (contextualTarget && candidate.contains(contextualTarget)) {
          const targetRange = document.createRange();
          targetRange.selectNodeContents(contextualTarget);
          const scratch = document.createRange();
          scratch.selectNodeContents(candidate);
          scratch.setEnd(targetRange.startContainer, targetRange.startOffset);
          start = normalizedOffset(candidateRaw, domRangeText(scratch).length);
          scratch.setEnd(targetRange.endContainer, targetRange.endOffset);
          end = normalizedOffset(candidateRaw, domRangeText(scratch).length);
        }
      } catch (_) {}

      if (start == null || end == null || end <= start) {
        // Locate the selected token in normalized text; don't let a trimmed
        // prefix shift later adjacent references one character to the left.
        const tokenIndex = candidateMatchSource.indexOf(selected.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-'));
        if (tokenIndex >= 0) { start = tokenIndex; end = tokenIndex + selected.length; }
      }

      if (start != null && end != null) {
        const containsReference = candidateRefs.some(ref => {
          const refText = normalizeSelectionText(ref.text || '').normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-');
          if (!refText) return false;
          let from = candidateMatchSource.indexOf(refText);
          while (from >= 0) {
            const to = from + refText.length;
            if (start < to && end > from) return true;
            // Version labels often sit adjacent to a citation, outside its text.
            if (isBibleVersionCodeToken(selected) && Math.min(Math.abs(start - to), Math.abs(end - from)) <= 80) return true;
            from = candidateMatchSource.indexOf(refText, from + 1);
          }
          return false;
        });
        if (containsReference) { block = candidate; break; }
      }
    }

    // Preserve the old nearest-block fallback for non-reference selections.
    if (!block) block = node?.closest?.('p,li,td,th,blockquote,article,section,div') || node;
    if (!block) return null;

    const rawSource = domText(block);
    const source = normalizeSelectionText(rawSource).normalize('NFKC');
    if (!source) return null;
    const refs = resolveBibleReferenceText(source.replace(/[\u2010-\u2015\u2212]/g, '-'));
    // Reference parsing removes invisible directional marks and collapses
    // whitespace. Occurrence matching must use that same normalized text,
    // while Range-derived offsets must be translated from the original DOM
    // text into the normalized string before comparing positions.
    const normalizedMatchSource = normalizeSelectionText(rawSource).normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-');
    const toNormalizedOffset = offset => {
      const boundedOffset = Math.max(0, Math.min(rawSource.length, offset));
      const prefix = rawSource.slice(0, boundedOffset);
      const normalizedPrefix = normalizeSelectionText(prefix).normalize('NFKC');
      // normalizeSelectionText trims both ends. When the raw prefix ends at
      // a separator between two tokens, the full normalized source retains
      // one interior space at that position. Count that separator so offsets
      // for the following token (e.g. "Romans" after "; ") stay aligned.
      const hasInteriorSeparator =
        normalizedPrefix.length > 0 &&
        boundedOffset < rawSource.length &&
        /[\s\u00A0\u2007\u202F]$/.test(prefix) &&
        /\S/.test(rawSource.slice(boundedOffset));
      return normalizedPrefix.length + (hasInteriorSeparator ? 1 : 0);
    };

    // Context is positional: the selected browser range must be inside the
    // exact occurrence of the parsed reference. Sharing a paragraph is not
    // enough, so an orphan 16/36 cannot borrow an earlier reference.
    const sel = window.getSelection?.();
    const selectedRange = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;

    const getOffset = (container, offset) => {
      const scratch = document.createRange();
      scratch.selectNodeContents(block);
      scratch.setEnd(container, offset);
      return domRangeText(scratch).length;
    };
    let selectionStart = null;
    let selectionEnd = null;
    if (selectedRange) {
      const selectedMeaningfulText = normalizeSelectionText(sel.toString()).normalize('NFKC');
      if (selectedMeaningfulText) {
        selectionStart = getOffset(selectedRange.startContainer, selectedRange.startOffset);
        selectionEnd = getOffset(selectedRange.endContainer, selectedRange.endOffset);
      }
    }

    // The physical click is authoritative when its word range is inside this
    // candidate block. This overrides stale but non-empty native selections.
    try {
      if (clickedWordRange && block.contains(clickedWordRange.startContainer)) {
        selectionStart = getOffset(clickedWordRange.startContainer, clickedWordRange.startOffset);
        selectionEnd = getOffset(clickedWordRange.endContainer, clickedWordRange.endOffset);
      }
    } catch (_) {}

    // Chromium can transiently expose a whitespace-only Range for a real
    // double-click on an isolated inline token. In that state, the browser
    // selection is not authoritative, but the event target still identifies
    // the exact DOM occurrence that was clicked. Use that occurrence only as
    // a positional fallback inside the same block. This preserves the rule
    // that an orphan number cannot borrow a reference from elsewhere.
    // Prefer the exact DOM token identified by the physical double-click
    // whenever it is available. This matters when a numeric token is repeated
    // in a spaced reference such as "Obadiah 1 1": the native Selection text
    // is only "1", so its text alone cannot tell chapter 1 from verse 1.
    try {
      const contextualTarget = getDoubleClickTargetElement(event) || initialNode;
      const targetText = normalizeSelectionText(contextualTarget?.textContent || '').normalize('NFKC');
      if (contextualTarget && block.contains(contextualTarget) && targetText === selected) {
        const targetRange = document.createRange();
        targetRange.selectNodeContents(contextualTarget);
        const targetStart = getOffset(targetRange.startContainer, targetRange.startOffset);
        const targetEnd = getOffset(targetRange.endContainer, targetRange.endOffset);
        if (targetEnd > targetStart) {
          selectionStart = targetStart;
          selectionEnd = targetEnd;
        }
      }
    } catch (_) {}

    if (selectionStart == null || selectionEnd == null) {
      // When Chromium's native Selection is transiently whitespace-only, use
      // the actual double-click coordinate to recover the text position. This
      // is more authoritative than event.target when the event bubbles through
      // a wrapper or Chromium has not committed the token Range yet.
      try {
        let pointRange = null;
        if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
          if (typeof document.caretRangeFromPoint === 'function') {
            pointRange = document.caretRangeFromPoint(event.clientX, event.clientY);
          } else if (typeof document.caretPositionFromPoint === 'function') {
            const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
            if (pos?.offsetNode) {
              pointRange = document.createRange();
              pointRange.setStart(pos.offsetNode, pos.offset);
              pointRange.collapse(true);
            }
          }
        }
        if (pointRange && block.contains(pointRange.startContainer)) {
          const pointOffset = getOffset(pointRange.startContainer, pointRange.startOffset);
          selectionStart = pointOffset;
          selectionEnd = pointOffset + Math.max(1, selected.length);
        }
      } catch (_) {}

      if (selectionStart == null || selectionEnd == null) {
        const targetElement = node instanceof Element ? node : (node?.parentElement || null);
        if (targetElement && block.contains(targetElement)) {
          const targetRange = document.createRange();
          targetRange.selectNodeContents(targetElement);
          selectionStart = getOffset(targetRange.startContainer, targetRange.startOffset);
          selectionEnd = getOffset(targetRange.endContainer, targetRange.endOffset);
        }
      }
    }
    if (selectionStart == null || selectionEnd == null) return null;

    const findOccurrences = (needle) => {
      const value = normalizeSelectionText(needle || '').normalize('NFKC');
      if (!value) return [];
      const escapeRegex = part => part.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
      const parts = value.split(/\s+/).map(part => escapeRegex(part).replace(/[\u2010-\u2015\u2212]/g, '-').replace(/-/g, '[-\\u2010-\\u2015\\u2212]'));
      if (!parts.length) return [];
      const pattern = new RegExp(parts.join('\\s+'), 'gi');
      const occurrences = [];
      let match;
      while ((match = pattern.exec(normalizedMatchSource))) {
        occurrences.push({start: match.index, end: match.index + match[0].length});
        if (match[0].length === 0) pattern.lastIndex++;
      }
      return occurrences;
    };

    if (selectionStart != null && selectionEnd != null) {
      selectionStart = toNormalizedOffset(selectionStart);
      selectionEnd = toNormalizedOffset(selectionEnd);
    }

    // Some sites render citations as plain text and double-clicking a book
    // abbreviation selects only one token (e.g. "Cor" in "1 Cor. 15:3, 4").
    // Resolve the captured book label itself before trusting a citation match:
    // otherwise a greedy label can absorb unrelated prose and borrow a later
    // reference (e.g. clicking "Cor" in prose opening Ezekiel).
    // Preserve nonconsecutive comma lists as individual MultiVerse references.
    if (selectionStart != null && selectionEnd != null) {
      const abbreviatedBookCitationPattern = /\b((?:[1-3]\s+|i{1,3}\s+)?[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})\s+(\d+)\s*:\s*(\d+(?:\s*,\s*\d+)*)(?:\s*[-–—]\s*(\d+))?/gi;
      let citationMatch;
      while ((citationMatch = abbreviatedBookCitationPattern.exec(normalizedMatchSource))) {
        const rawBookLabel = citationMatch[1];
        const trimmedBookLabel = rawBookLabel.trim();
        const leadingTrim = rawBookLabel.length - rawBookLabel.trimStart().length;
        const labelTokens = [...trimmedBookLabel.matchAll(/\S+/g)];
        let book = null;
        let bookLabelStart = citationMatch.index + leadingTrim;
        let bookLabelEnd = null;
        // The broad matcher can include preceding prose (e.g. "The word Cor
        // appears here. See Ezekiel"). Resolve the longest valid suffix as the
        // actual Bible book label, and bound the positional match to that suffix
        // only. Including the preceding prose makes an unrelated word such as
        // "Cor" appear to belong to the later Ezekiel citation.
        for (let tokenIndex = labelTokens.length - 1; tokenIndex >= 0; tokenIndex--) {
          const token = labelTokens[tokenIndex];
          const candidate = trimmedBookLabel.slice(token.index);
          // Keep an explicit book ordinal attached to its abbreviation: "1 Cor"
          // must not be shortened to an ambiguous "Cor" suffix.
          const precedingToken = tokenIndex > 0
            ? trimmedBookLabel.slice(0, token.index).trim().split(/\s+/).pop()
            : '';
          if (/^(?:[1-3]|i{1,3})$/i.test(precedingToken)) continue;
          const candidateBook = resolveBibleBook(candidate);
          if (candidateBook) {
            book = candidateBook;
            bookLabelStart = citationMatch.index + leadingTrim + token.index;
            bookLabelEnd = bookLabelStart + candidate.length;
            break;
          }
        }
        if (!book || bookLabelEnd == null) continue;
        if (selectionStart >= bookLabelEnd || selectionEnd <= bookLabelStart) continue;
        const chapter = Number(citationMatch[2]);
        const listedVerses = citationMatch[3]
          ? citationMatch[3].split(',').map(value => Number(value.trim()))
          : [];
        if (!listedVerses.length) continue;
        if (listedVerses.length > 1) {
          const resolvedVerses = listedVerses.map(verse =>
            resolveBibleReference(book.name, chapter, verse, verse)
          );
          if (resolvedVerses.some(ref => !ref)) continue;
          if (listedVerses.every((verse, index) => index === 0 || verse === listedVerses[index - 1] + 1)) {
            const expanded = resolveBibleReference(book.name, chapter, listedVerses[0], listedVerses[listedVerses.length - 1]);
            if (expanded) return {book: expanded.book, chapter: expanded.chapter, from: expanded.from, to: expanded.to, url: expanded.url};
          }
          return {
            refs: resolvedVerses.map(ref => ({
              book: ref.book.name,
              bookNumber: Number(ref.book.bookNumber),
              chapter: ref.chapter,
              from: ref.from,
              to: ref.to,
              version: 'kjv'
            }))
          };
        }
        const rangeEnd = citationMatch[4] ? Number(citationMatch[4]) : listedVerses[0];
        const parsed = resolveBibleReference(book.name, chapter, listedVerses[0], rangeEnd);
        if (parsed) return {book: parsed.book, chapter: parsed.chapter, from: parsed.from, to: parsed.to, url: parsed.url};
      }
    }

    // Resolve consecutive comma-separated verse lists before consulting the
    // general parser. The general parser may return only the first verse
    // (e.g. Romans 10:9) even when the clicked token is the book or chapter
    // and the surrounding citation is Romans 10:9,10. Use the exact clicked
    // position to ensure this only expands a citation that contains the
    // double-clicked token; unrelated references elsewhere in the block do
    // not qualify.
    if (selectionStart != null && selectionEnd != null) {
      const verseListReference = resolveBibleReferenceFromContextWindow(
        normalizedMatchSource,
        selectionStart,
        selectionEnd
      );
      if (verseListReference) return verseListReference;
    }

    // Book-name selections can still be identified reliably when a rich-text
    // DOM makes Range-derived offsets drift after whitespace normalization.
    // Anchor the selected canonical book token to the same parsed occurrence;
    // never let a prose mention borrow a different reference elsewhere.
    const selectedBook = resolveBibleBook(selected);
    const selectedBookPositions = [];
    if (selectedBook) {
      const escapedSelected = selected.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      const selectedPattern = new RegExp('(?<![A-Za-z0-9])' + escapedSelected + '(?![A-Za-z0-9])', 'gi');
      let selectedMatch;
      while ((selectedMatch = selectedPattern.exec(normalizedMatchSource))) {
        selectedBookPositions.push(selectedMatch.index);
        if (!selectedMatch[0].length) selectedPattern.lastIndex++;
      }
    }
    const nearestSelectedBookPosition = selectedBookPositions.length
      ? selectedBookPositions.reduce((best, position) =>
          Math.abs(position - selectionStart) < Math.abs(best - selectionStart) ? position : best,
        selectedBookPositions[0])
      : null;

    // Version codes are adjacent metadata, not part of the citation itself.
    // Select the nearest parsed reference in the same local DOM block, regardless
    // of parentheses or punctuation, and return its canonical KJV reference URL.
    if (isBibleVersionCodeToken(selected)) {
      const nearby = [];
      for (const ref of refs) {
        if (!ref || ref.chapter == null || !ref.text) continue;
        for (const occurrence of findOccurrences(ref.text)) {
          const isBeforeVersion = occurrence.end <= selectionStart;
          const isAfterVersion = occurrence.start >= selectionEnd;
          const distance = isBeforeVersion
            ? selectionStart - occurrence.end
            : isAfterVersion
              ? occurrence.start - selectionEnd
              : 0;
          if (distance <= 80) {
            nearby.push({ref, distance, start: occurrence.start, isBeforeVersion});
          }
        }
      }
      // Most citations are written before the version label (e.g. "John 3:16 NIV").
      // Prefer a nearby reference to the left of the clicked code. Only use a
      // reference to the right when no preceding citation is within the context
      // window, as in "NIV — John 3:16".
      const preceding = nearby.filter(item => item.isBeforeVersion)
        .sort((a, b) => a.distance - b.distance || b.start - a.start);
      const candidates = preceding.length
        ? preceding
        : nearby.filter(item => !item.isBeforeVersion)
          .sort((a, b) => a.distance - b.distance || a.start - b.start);
      const closest = candidates[0]?.ref;
      if (closest) return {book:closest.book,chapter:closest.chapter,from:closest.from,to:closest.to,url:closest.url};
      return null;
    }

    for (const ref of refs) {
      if (!ref || ref.chapter == null || !ref.text) continue;
      const occurrences = findOccurrences(ref.text);
      for (const occurrence of occurrences) {
        if (selectionStart >= occurrence.start && selectionEnd <= occurrence.end) {
          return {book:ref.book,chapter:ref.chapter,from:ref.from,to:ref.to,url:ref.url};
        }
      }

      // If the clicked token is itself a Bible book name, permit a normalized
      // token-position match as a fallback for nested spans/formatting marks.
      // The book token must occupy the corresponding position inside this
      // exact parsed reference occurrence; an unrelated mention cannot qualify.
      const refBook = resolveBibleBook(ref.book);
      if (!selectedBook || !refBook || selectedBook.urlKey !== refBook.urlKey ||
          nearestSelectedBookPosition == null) continue;
      const normalizedRefText = normalizeSelectionText(ref.text || '').normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-');
      const escapedRefBook = refBook.name.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      const bookInRef = new RegExp('(?<![A-Za-z0-9])' + escapedRefBook + '(?![A-Za-z0-9])', 'i').exec(normalizedRefText);
      if (!bookInRef) continue;
      for (const occurrence of occurrences) {
        if (occurrence.start + bookInRef.index === nearestSelectedBookPosition) {
          return {book:ref.book,chapter:ref.chapter,from:ref.from,to:ref.to,url:ref.url};
        }
      }
    }
  } catch (_) {}
  return null;
}

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
        let selection=normalizeSelectionText(getDoubleClickSelection(event)).normalize('NFKC');
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
        // A suffix such as "Peter" or "Cor" can be part of a numbered book
        // name. Only enter contextual matching when the complete nearby prefix
        // resolves to a real Bible book; arbitrary words remain fast-rejected.
        const possibleNumberedBookSuffix=/^(?:Sam(?:uel)?|Kings|Kgs?|Chronicles|Chr|Corinthians|Cor|Thessalonians|Thess|Timothy|Tim|Peter|Pet|John|Jn|Jhn)$/i.test(selection);

        // For explicit verse cues and numbered-book suffixes, prefer the
        // physical event target where needed. The generic caret-target helper
        // can return a nearby/stale element on pages with inline citation spans.
        const cueElement = [physicalTarget, getDoubleClickTargetElement(event)].find(candidate =>
          /^(?:v|verse|verses)$/i.test(normalizeSelectionText(candidate?.textContent || '').normalize('NFKC'))
        );
        const contextualTarget = possibleNumberedBookSuffix
          ? physicalTarget
          : (isVerseContextWord
            ? (cueElement || getDoubleClickTargetElement(event) || event.target)
            : (getDoubleClickTargetElement(event) || event.target));
        const isRomanBookPrefix=/^(?:I|II|III)$/i.test(selection);
        let hasValidNearbyBookPrefix=false;
        let hasValidNearbyRomanBookPrefix=false;
        let numberedSuffixReference=null;
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

            // A numbered-book suffix such as "Cor" may be the clicked part of
            // a chapter-only citation ("1 Cor. 13"). Resolve that exact nearby
            // citation directly instead of letting the generic DOM resolver
            // borrow an unrelated reference from an ancestor or stale selection.
            if (completeBook && possibleNumberedBookSuffix
                && match[2].toLowerCase()===selection.toLowerCase()
                && /^[1-3]$/.test(match[1])) {
              const afterBook=contextText.slice(match.index+match[0].length);
              const chapterMatch=afterBook.match(/^\s*\.?\s*(\d{1,3})\b/);
              const chapter=chapterMatch ? Number(chapterMatch[1]) : 0;
              if (chapter>0) {
                const resolvedBook=resolveBibleBook(prefixNumber+' '+match[2]);
                if (resolvedBook) numberedSuffixReference=resolveBibleReference(resolvedBook.name,chapter,1,1);
              }
            }
          } catch (_) {}
        }
        // "verse" is not guaranteed to be in the local KJV word index on
        // every build, but in a Facebook post it is the explicit cue for a
        // nearby verse number. Let the tightly gated post resolver inspect it.
        // A native double-click selection over comma-separated verse numbers (for example, "9,10")
        // is not itself a numeric token. Still run the DOM-context resolver so it can use the
        // physical click position to identify the clicked number and resolve the full citation.
        const isCommaSeparatedNumericSelection=/^\d{1,3}(?:\s*,\s*\d{1,3})+$/.test(selection);
        const needsDomContext=isNumericBookCandidate||isCommaSeparatedNumericSelection||isBookName||isPrefixedBookName||hasValidNearbyBookPrefix||hasValidNearbyRomanBookPrefix||isBibleVersionCode||isReferenceDashGesture||isVerseContextWord;
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
        const contextualReference=numberedSuffixReference
          || (isNumberedListSerial && standaloneBook
            ? standaloneBook
            : (isStandaloneNumericBook ? standaloneBook : (blockContext||standaloneBook)));
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
      } catch (_) {
        return false;
      }
    };

    requestAnimationFrame(dispatch);
  } catch (_) {}
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

// Floating page-selection control is initialized by its feature module.
function getPageSelectionSiteKey() {
  let host = String(location.hostname || '').toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

const blbPageSelectionButton = globalThis.BLBPageSelectionButtonModule.initialize({
  BLBShared: BLBShared,
  BOOKS: BOOKS,
  BOOK_ALIASES: BOOK_ALIASES,
  KJV_CORPUS_WORD_INDEX: KJV_CORPUS_WORD_INDEX,
  canonicalStrongValue: canonicalStrongValue,
  resolveBibleReference: resolveBibleReference,
  resolveBibleBook: resolveBibleBook,
  resolveBibleReferenceText: resolveBibleReferenceText,
  normalizeSelectionText: normalizeSelectionText,
  normalizeDoubleClickToken: normalizeDoubleClickToken,
  getContextualBibleReference: getContextualBibleReference,
  safeRuntimeSendMessage: safeRuntimeSendMessage,
  isSensitiveSiteHostname: isSensitiveSiteHostname,
  getSiteDefaultEnabled: getSiteDefaultEnabled,
  refreshDoubleClickBlb: refreshDoubleClickBlb,
  suiteSettingsReadyPromise: suiteSettingsReadyPromise,
  isSuiteEnabledNow: () => suiteEnabled,
  makeBlbMultiVerseButtonDraggable: makeBlbMultiVerseButtonDraggable,
  getPageSelectionSiteKey: getPageSelectionSiteKey
});


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
      blbPageSelectionButton.disable();
    } else {
      if (location.hostname === 'webstersdictionary1828.com') globalThis.BLBWebsterCollector?.ensureButton?.();
      blbPageSelectionButton.refresh();
    }
  }

  if (changes.pageSelectionButtonSites && suiteEnabled) {
    blbPageSelectionButton.refresh();
  }

  if (changes.doubleClickBlbSites) {
    refreshDoubleClickBlb();
  }
});

})();