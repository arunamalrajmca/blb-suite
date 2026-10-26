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

function redirectBibleSite() {
  const u=new URL(location.href), host=u.hostname.toLowerCase().replace(/^www\./,"");
  let ref=null;

  if (host==="thekingsbible.com") {
    const path=u.pathname.replace(/\/{2,}/g,"/");
    // Keep The King's Bible homepage and Dictionary/Concordance landing pages accessible.
    // Redirect only specific dictionary/concordance entries, not their root pages or empty anchors.
    if (path==="/" || /^\/(?:dictionary|concordance)\/?$/i.test(path)) return false;
    let m=path.match(/^\/StrongsNo\/([GH])0*(\d+)\/?$/i);
    if (m) {
      const language=m[1].toLowerCase();
      const target=`${BLBShared.urls.blbOrigin}/lexicon/${language}${Number(m[2])}/kjv/${language==="h"?"wlc":"tr"}/0-1/`;
      if (target!==u.href) { location.replace(target); return true; }
      return false;
    }
    // The King’s Bible uses canonical numeric book order in /Bible/<book>/<chapter>.
    m=path.match(/^\/Bible\/(\d+)\/(\d+)\/?$/i);
    if (m) {
      const book=BOOKS.find(item=>Number(item.bookNumber)===Number(m[1]));
      if (book) {
        const chapter=Number(m[2]);
        const verseParam=u.searchParams.get("verse");
        const verse=verseParam && /^\d+$/.test(verseParam) ? Number(verseParam) : 1;
        ref={book:book.name,chapter,from:verse,to:null};
      }
    }
  }

  if (host==="bible.com") {
    // Ignore the selected translation/version completely. Any version clicked
    // on Bible.com is redirected to the KJV equivalent in BLB.
    const m=u.pathname.match(/^\/bible\/[^/]+\/([^./]+)\.(\d+)(?:\.(\d+)(?:-(\d+))?)?(?:\.[^/]+)?\/?$/i);
    if (m) ref={book:m[1],chapter:+m[2],from:m[3]?+m[3]:1,to:m[4]?+m[4]:null};
  }

  if (host==="christianity.com") {
    // Christianity.com Bible pages use /bible/<version>/<book>/<chapter>,
    // /bible/<version>/<book>/<chapter>-<verse>, and verse ranges ending in -<end>.
    // Ignore the source translation and preserve the requested KJV passage.
    ref=parseChristianityBibleLink(u.href);
  }

  if (host==="esv.org") {
    // ESV.org uses both /verses/<reference>/ and root-level passage URLs
    // such as /Ephesians+2/ and /John+3%3A16/. Decode plus signs and encoded
    // punctuation, then let the shared reference resolver validate the book
    // and passage. Root-level non-reference pages (including the homepage)
    // are ignored.
    const versePath=u.pathname.match(/^\/verses\/(.+?)\/?$/i);
    if (versePath) {
      ref=validateSourceBibleReference(parseRef(decodeSafe(versePath[1]).replace(/\+/g," ").replace(/[–—]/g,"-")));
    } else {
      const rootPath=u.pathname.match(/^\/([^/]+)\/?$/);
      if (rootPath && /[+%\s]/.test(rootPath[1]) || rootPath && /\d/.test(decodeSafe(rootPath[1]))) {
        const candidate=decodeSafe(rootPath[1]).replace(/\+/g," ").replace(/[–—]/g,"-");
        if (/^[\p{L}\d][\p{L}\d\s.'-]*\s+\d+(?::\d+(?:-\d+)?)?$/u.test(candidate)) {
          ref=validateSourceBibleReference(parseRef(candidate));
        }
      }
    }
  }

  if (host==="biblegateway.com" && u.pathname.toLowerCase()==="/passage/") {
    // The version=... parameter is deliberately ignored; always target KJV.
    ref=parseRef(u.searchParams.get("search")||"");
  }

  if (host==="bibleref.com") {
    const p=u.pathname.split("/").filter(Boolean);
    if (p.length>=2 && /^\d+$/.test(p[1])) {
      // Commentary path: /john/3/john-3-16.html (or a verse range).
      const vm=u.pathname.match(new RegExp("-"+p[1]+"-(\\d+)(?:-(\\d+))?\\.html$", "i"));
      if (vm) ref={book:p[0],chapter:+p[1],from:+vm[1],to:vm[2]?+vm[2]:null};
      else if (/^\/[^/]+\/\d+\/?$/i.test(u.pathname)) ref={book:p[0],chapter:+p[1],from:1,to:null};
    }
    // Search-result route: /biblepassage/?search=John_3%3A16-17.
    if (!ref && u.pathname.toLowerCase()==="/biblepassage/") {
      const search=u.searchParams.get("search")||"";
      ref=parseRef(search.replace(/_/g," "));
    }
  }

  if (host==="biblehub.com") {
    // Standard passage: /john/3-16.htm. Translation-prefixed passage:
    // /kjv/john/3-16.htm (the source version never controls BLB's KJV target).
    let m=u.pathname.match(/^\/([^/]+)\/(\d+)(?:-(\d+)(?:-(\d+))?)?\.htm$/i);
    if (m) {
      ref={book:m[1],chapter:+m[2],from:m[3]?+m[3]:1,to:m[4]?+m[4]:null};
    } else {
      m=u.pathname.match(/^\/([a-z0-9-]+)\/([^/]+)\/(\d+)(?:-(\d+)(?:-(\d+))?)?\.htm$/i);
      if (m && /^(?:kjv|niv|esv|nkjv|nasb|nasb20|nlt|bsb|asv|web|amp|net|csb|msg|hcsb)$/i.test(m[1])) {
        ref={book:m[2],chapter:+m[3],from:m[4]?+m[4]:1,to:m[5]?+m[5]:null};
      } else {
        // Bible Hub's alternate passage route: /passage/john/3/16-18.
        m=u.pathname.match(/^\/passage\/([^/]+)\/(\d+)\/(\d+)(?:-(\d+))?\/?$/i);
        if (m) ref={book:m[1],chapter:+m[2],from:+m[3],to:m[4]?+m[4]:null};
      }
    }
  }

  if (host==="kingjamesbibleonline.org" || host==="kjbo.org") {
    // Some entry URLs arrive with repeated leading slashes after the host.
    // Normalize only this source site's path before applying its known routes.
    const path=u.pathname.replace(/^\/{2,}/, "/");
    let m=path.match(/^\/([^/]+)-Chapter-(\d+)(?:_Original-1611-KJV)?\/?$/i);
    if (m && bookKey(m[1])) ref={book:m[1],chapter:+m[2],from:1,to:null};
    else {
      // Compact chapter routes use /Psalms-23/. Require a known book so
      // verse URLs cannot be misclassified as chapters.
      m=path.match(/^\/([^/]+?)-(\d+)\/?$/i);
      if (m && bookKey(m[1])) ref={book:m[1],chapter:+m[2],from:1,to:null};
      else {
        // Non-greedy book capture preserves numbered books and verse ranges:
        // /John-3-16-18/ and /1-John-4-7-8/.
        m=path.match(/^\/([^/]+?)-(\d+)-(\d+)(?:-(\d+))?\/?$/i);
        if (m && bookKey(m[1])) ref={book:m[1],chapter:+m[2],from:+m[3],to:m[4]?+m[4]:null};
        else {
          // KJV Online also represents same-chapter ranges as John-3-16_3-17.
          m=path.match(/^\/([^/]+?)-(\d+)-(\d+)_(\d+)-(\d+)\/?$/i);
          if (m && bookKey(m[1]) && m[2]===m[4]) ref={book:m[1],chapter:+m[2],from:+m[3],to:+m[5]};
        }
      }
    }
  }

  if (host==="kjv.site" || host==="m.kjv.site") {
    // The chapter pattern can greedily treat a verse URL such as
    // /John-3-16-kjv/ as book "John-3", chapter 16. Only accept a chapter
    // match when its book token resolves; otherwise try the verse pattern.
    let m=u.pathname.match(/^\/([^/]+)-(\d+)-kjv\/?$/i);
    if (m && bookKey(m[1])) {
      ref={book:m[1],chapter:+m[2],from:1,to:null};
    } else {
      m=u.pathname.match(/^\/([^/]+)-(\d+)-(\d+)(?:-(\d+))?-kjv\/?$/i);
      if (m && bookKey(m[1])) ref={book:m[1],chapter:+m[2],from:+m[3],to:m[4]?+m[4]:null};
    }
  }

  if (host==="officialkingjamesbible.com") {
    // OfficialKingJamesBible.com uses /bible/<book>/<chapter> for a
    // chapter and /bible/<book>/<chapter>/<verse> for a single verse.
    // It is a KJV site, so send the same passage to BLB KJV.
    const m=u.pathname.match(/^\/bible\/([^/]+)\/(\d+)(?:\/(\d+)(?:-(\d+))?)?\/?$/i);
    if (m) ref={book:m[1],chapter:+m[2],from:m[3]?+m[3]:1,to:m[4]?+m[4]:null};
  }

  if (host==="bibleportal.com") {
    // BiblePortal can encode the reference in either ?v=... or
    // ?v=...&version=... / verse-topic URLs. Ignore the version entirely.
    const v=u.searchParams.get("v");
    if (v) ref=parseRef(v);
    if (!ref) {
      const topic=u.searchParams.get("verse-topic");
      if (topic) ref=parseRef(topic);
    }
  }

  if (!ref) return false;
  // Chapter numbers must identify a real positive chapter. Verse numbers,
  // however, follow the shared resolver's boundary policy: values below 1 map
  // to verse 1 and values above the chapter maximum map to its last verse.
  // Descending ranges remain invalid rather than being silently reinterpreted.
  if (!Number.isInteger(ref.chapter) || ref.chapter < 1) return false;
  if (ref.from != null && !Number.isInteger(ref.from)) return false;
  if (ref.to != null && (!Number.isInteger(ref.to) || ref.to < (ref.from == null ? 1 : ref.from))) return false;
  const target=blbUrl(ref.book,ref.chapter,ref.from,ref.to);
  if (!target) return false;
  if (target!==u.href) {
    // Christianity.com remains open in its original tab. Open resolved
    // chapter/verse passages in a new BLB tab rather than replacing the source.
    if (host==="christianity.com") {
      openBlbDestinationFromContent(target);
      return true;
    }
    location.replace(target);
    return true;
  }
  return false;
}

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
const BLBDoubleClickContext = globalThis.BLBDoubleClickContextModule.create({
  documentApi:document,
  windowApi:window,
  NodeCtor:Node,
  ElementCtor:Element,
  books:BOOKS,
  shared:BLBShared,
  normalizeSelectionText,
  parseRef,
  validateSourceBibleReference
});
const { normalizeDoubleClickToken, getAdjacentBoundaryText, getSelectionContextPosition, resolveBibleReferenceFromContextWindow, getContextualBibleReference, getStandaloneBookReference, isBibleVersionCodeToken, getDoubleClickBlockContextReference } = BLBDoubleClickContext;

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

function isBlbPageButtonExcludedSite() {
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  // Exclude only BLB subdomains other than the main hostname. Ordinary external
  // sites must remain eligible when Show on BLB is explicitly enabled.
  return host !== BLBShared.hostnames.blb && host.endsWith('.' + BLBShared.hostnames.blb);
}


function getSelectedPageText() {
  try {
    return normalizeSelectionText(window.getSelection?.().toString() || '');
  } catch (_) {
    return '';
  }
}


// Fast, local structural check for Bible references. This avoids making the
// floating button depend on a background-service response for an unambiguous
// reference such as "John 3:16". Phrase/topic selections still use the
// background KJV verification path below.
function hasLocalValidBibleReference(text) {
  // Keep the user's selection untouched elsewhere; normalize styled Unicode
  // only for this fast local reference check.
  const source = normalizeSelectionText(text)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return false;
  if (canonicalStrongValue(source)) return true;

  const entries = [];
  const seen = new Set();
  const add = (name, book) => {
    const value = String(name || '').trim();
    if (!value || !book || seen.has(value.toLowerCase())) return;
    seen.add(value.toLowerCase());
    entries.push({name:value, book});
  };

  for (const book of BOOKS) {
    add(book.name, book);
    add(book.urlKey, book);
    if (book.bookNumber) add(book.bookNumber, book);
  }
  for (const [alias, target] of Object.entries(BOOK_ALIASES)) {
    const book = BOOKS.find(b => b.name === target);
    if (book) add(alias, book);
  }

  entries.sort((a,b) => b.name.length - a.name.length);
  for (const entry of entries) {
    const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?:^|[^A-Za-z0-9])${escaped}\\.?\\s+(-?\\d+)(?:(?::|\\.)\\s*(-?\\d+)(?:\\s*[-–]\\s*(-?\\d+))?|\\s+(-?\\d+)(?:\\s*[-–]\\s*(-?\\d+))?)?(?=$|[^A-Za-z0-9])`, 'i');
    const match = re.exec(source);
    if (!match) continue;

    const chapter = Number(match[1]);
    const verse = match[2] ? Number(match[2]) : (match[4] ? Number(match[4]) : null);
    const verseTo = match[3] ? Number(match[3]) : (match[5] ? Number(match[5]) : null);
    // Use the same shared canonical resolver as Omnibox, Alt+B, right-click,
    // and the background selection path. This keeps the floating button in
    // sync with the generic 66-book chapter/verse boundary rules, including
    // out-of-range clamping such as Rev 26:1 -> Rev 22:1.
    const resolved = resolveBibleReference(entry.book.name, chapter, verse, verseTo);
    if (resolved) return true;
  }

  // A complete Bible book name by itself is also actionable. The entire
  // selection must be the book name; merely mentioning a book inside a
  // larger sentence or article must not activate the button.
  for (const entry of entries) {
    const normalizeBook = value => String(value || '')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/[.]/g, '');
    if (normalizeBook(source) === normalizeBook(entry.name)) return true;
  }


  return false;
}

function stopBlbPageSelectionDomObserver() {
  // A queued validation belongs to the visibility/selection state that
  // scheduled it. Do not let it run after the observer is stopped and the
  // button is subsequently shown for a different keyboard selection.
  if (pageButtonDomValidationFrame) {
    cancelAnimationFrame(pageButtonDomValidationFrame);
    pageButtonDomValidationFrame = 0;
  }
  if (!pageButtonDomObserver) return;
  pageButtonDomObserver.disconnect();
  pageButtonDomObserver = null;
}

function syncBlbPageSelectionDomObserver() {
  // Observe only while there is a visible action whose cached selection needs
  // protection. Hidden-button pages should not pay for document-wide mutation
  // notifications.
  if (!pageButtonMonitoring || !blbPageButtonVisible || !document.documentElement) {
    stopBlbPageSelectionDomObserver();
    return;
  }
  if (!pageButtonDomObserver) {
    pageButtonDomObserver = new MutationObserver(() => {
      // Mutation callbacks can run between DOM updates that belong to one
      // selection change. Validate once the browser has settled the frame.
      if (pageButtonDomValidationFrame) return;
      pageButtonDomValidationFrame = requestAnimationFrame(() => {
        pageButtonDomValidationFrame = 0;
        validateBlbPageSelectionAfterDomMutation();
      });
    });
  }
  pageButtonDomObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function invalidateBlbPageSelectionButton() {
  blbPageButtonSelection = '';
  blbPageButtonContextualReference = null;
  blbPageButtonDirectUrl = null;
  lastSelectionContextualReference = null;
  lastSelectionContextualText = '';
  blbPageButtonVisible = false;
  stopBlbPageSelectionDomObserver();
  const button = document.getElementById(BLB_PAGE_BUTTON_ID);
  if (button) button.style.display = 'none';
  // Do not expose a stale selection to the context-menu entry.
}

// A page can replace or rewrite selected DOM without dispatching input,
// keyboard, or pointer events. If that happens, the native Selection can
// continue to reference detached nodes and the floating action must be
// invalidated instead of acting on cached text from the old document content.
function validateBlbPageSelectionAfterDomMutation() {
  if (!pageButtonMonitoring || !blbPageButtonVisible) return;
  try {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) {
      invalidateBlbPageSelectionButton();
      return;
    }
    const range = selection.getRangeAt(0);
    const currentText = normalizeSelectionText(selection.toString());
    const cachedText = normalizeSelectionText(blbPageButtonSelection);
    if (!range.startContainer?.isConnected || !range.endContainer?.isConnected ||
        !currentText || currentText !== cachedText) {
      invalidateBlbPageSelectionButton();
    }
  } catch (_) {
    invalidateBlbPageSelectionButton();
  }
}

function setBlbPageButtonVisible(visible) {
  blbPageButtonVisible = !!visible;
  const button = document.getElementById(BLB_PAGE_BUTTON_ID);
  if (button) button.style.display = blbPageButtonVisible ? 'block' : 'none';
  syncBlbPageSelectionDomObserver();
  // Keep the right-click Show on BLB item synchronized with the exact same
  // live eligibility state. The background handler also receives tab context
  // through sender.tab, so no separate classifier is needed here.
}

function removeBlbPageSelectionButton() {
  setBlbPageButtonVisible(false);
  const button = document.getElementById(BLB_PAGE_BUTTON_ID);
  button?.__blbDragVisibilityObserver?.disconnect();
  document.getElementById(BLB_PAGE_BUTTON_ID + '-reset-position')?.remove();
  button?.remove();
  blbPageButtonSelection = '';
}

function addBlbPageSelectionButton() {
  if (document.getElementById(BLB_PAGE_BUTTON_ID) || isBlbPageButtonExcludedSite()) return;
  // document.documentElement is available at document_start; do not require
  // document.body, because many sites create it later.
  const mount = document.documentElement || document.body;
  if (!mount) return;

  const button = document.createElement('button');
  button.id = BLB_PAGE_BUTTON_ID;
  button.type = 'button';
  button.textContent = 'Show on BLB';
  button.title = 'Open the selected Bible text or references in BLB (Alt+B)';
  button.setAttribute('aria-label', 'Show on BLB');
  const isWebsterPage = location.hostname.toLowerCase() === 'webstersdictionary1828.com';
  const buttonBottom = isWebsterPage ? 'bottom:68px' : 'bottom:20px';
  button.style.cssText = [
    'position:fixed !important','right:20px',buttonBottom,'z-index:2147483647 !important','max-width:calc(100vw - 40px) !important',
    'display:none','padding:9px 13px','border-radius:7px',
    'background:#292a2d','color:#f1f3f4','border:1px solid #505257','font:600 13px Arial,sans-serif',
    'line-height:1.2','cursor:pointer','box-shadow:0 2px 8px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08)',
    'transition:transform .12s ease,box-shadow .12s ease,background .12s ease',
    'user-select:none'
  ].join(';');

  button.addEventListener('mouseenter', () => { button.style.background='#303136'; button.style.transform='translateY(-1px)'; button.style.boxShadow='0 4px 12px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.1)'; });
  button.addEventListener('mouseleave', () => { button.style.background='#292a2d'; button.style.transform='translateY(0)'; button.style.boxShadow='0 2px 8px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08)'; });
  button.addEventListener('mousedown', () => { button.style.transform='translateY(1px)'; button.style.boxShadow='0 1px 3px rgba(0,0,0,.38),inset 0 1px 2px rgba(0,0,0,.22)'; });
  button.addEventListener('mouseup', () => { button.style.transform='translateY(-1px)'; button.style.boxShadow='0 4px 12px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.1)'; });

  button.addEventListener('mousedown', e => {
    // Preserve the page selection while the floating control is clicked.
    // The document-level selection handlers must not treat this as a new
    // selection gesture.
    e.preventDefault();
    e.stopPropagation();
    pageButtonActionInProgress = true;
  });
  button.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const text = blbPageButtonSelection || getSelectedPageText();
    if (!text || !suiteEnabled) {
      pageButtonActionInProgress = false;
      return;
    }
    // Ignore stale content-script contexts if the extension was reloaded.
    safeRuntimeSendMessage({
      type:'blbSuiteOpenSelectionText',
      text,
      contextualReference: blbPageButtonContextualReference || null,
      directUrl: blbPageButtonDirectUrl || null,
      // A single-token floating-button action should follow the same fast path
      // as double-click: do not re-scan page context after the selection has
      // already been accepted as a word. Multi-word selections still resolve
      // adjacent references through the normal background path.
      contextualReferenceResolved: !blbPageButtonContextualReference && !/\\s/.test(text),
      tabBehavior:{activeIfNew:true,activateExisting:true}
    });
    clearBlbPageSelectionAfterAction();
    setTimeout(() => { pageButtonActionInProgress = false; }, 0);
  });

  mount.appendChild(button);
  makeBlbMultiVerseButtonDraggable(button, {
    positionKey: 'blbSuiteShowOnBLBButtonPosition',
    defaultRight: 20,
    defaultBottom: isWebsterPage ? 68 : 20
  });
}

async function updateBlbPageSelectionButtonFromSelection() {
  if (!pageButtonMonitoring || isBlbPageButtonExcludedSite() || isSensitiveSiteHostname(location.hostname)) return;
  let button = document.getElementById(BLB_PAGE_BUTTON_ID);
  if (!button) {
    addBlbPageSelectionButton();
    button = document.getElementById(BLB_PAGE_BUTTON_ID);
  }
  if (!button) return;

  const text = getSelectedPageText();
  blbPageButtonSelection = text;
  blbPageButtonContextualReference = null;
  blbPageButtonDirectUrl = null;
  setBlbPageButtonVisible(false);
  if (!text || !suiteEnabled) return;

  // Match the Double-Click BLB fast-reject rule for single-word selections.
  // Hide the floating button for non-ASCII tokens and English words absent
  // from the local KJV vocabulary, while allowing KJV words and book names.
  if (!/\s/.test(text) && /[^\x00-\x7F]/.test(text)) {
    blbPageButtonSelection = '';
    return;
  }
  if (/^[A-Za-z][A-Za-z'’\\-]*$/.test(text)) {
    const token = normalizeDoubleClickToken(text).replace(/’/g, "'");
    const isKjvWord = typeof KJV_CORPUS_WORD_INDEX !== 'undefined'
      && KJV_CORPUS_WORD_INDEX.has(token);
    const isBookName = !!resolveBibleBook(text);
    if (!isKjvWord && !isBookName) {
      blbPageButtonSelection = '';
      return;
    }
  }

  if (text) {
    // Fast path: an exact single reference can be resolved locally once while
    // the selection is being classified. Retain its validated BLB URL so the
    // click does not repeat selection classification in the background worker.
    const directRefs = resolveBibleReferenceText(normalizeSelectionText(text));
    if (directRefs.length === 1) {
      const direct = directRefs[0];
      const selectedNormalized = normalizeSelectionText(text).replace(/\s+/g, ' ').trim();
      const referenceNormalized = normalizeSelectionText(direct.text || '').replace(/\s+/g, ' ').trim();
      if (selectedNormalized && referenceNormalized === selectedNormalized && direct.url) {
        const contextual = {
          book: direct.book,
          chapter: direct.chapter,
          from: direct.from,
          to: direct.to,
          url: direct.url
        };
        blbPageButtonContextualReference = contextual;
        blbPageButtonDirectUrl = direct.url;
        lastSelectionContextualReference = contextual;
        lastSelectionContextualText = text;
      }
    }
    if (!blbPageButtonContextualReference) {
      const contextual = getContextualBibleReference(text);
      if (contextual?.url) {
        blbPageButtonContextualReference = contextual;
        lastSelectionContextualReference = contextual;
        lastSelectionContextualText = text;
      }
    }
  }
  // Show the floating control for accepted selections, including multiword
  // text and partial references that need the shared background resolver.
  setBlbPageButtonVisible(true);
}

function scheduleFinalBlbPageSelectionButtonUpdate() {
  if (!pageButtonMonitoring) return;
  if (pageButtonSelectionFrame) cancelAnimationFrame(pageButtonSelectionFrame);
  // Let the browser finish applying the selection boundary update before we
  // read document.getSelection(). This avoids validating a stale range.
  setTimeout(() => {
    if (!pageButtonMonitoring) return;
    pageButtonSelectionFrame = requestAnimationFrame(() => {
      pageButtonSelectionFrame = 0;
      updateBlbPageSelectionButtonFromSelection().catch(()=>{});
    });
  }, 0);
}

function handleBlbPageSelectionMouseDown(event) {
  if (!pageButtonMonitoring || pageButtonActionInProgress) return;
  if (event?.target instanceof Element && event.target.closest(`#${BLB_PAGE_BUTTON_ID}, #${BLB_PAGE_BUTTON_ID}-reset-position`)) return;
  // Preserve an existing selection for the native right-click menu.
  if (event?.button === 2) return;
  invalidateBlbPageSelectionButton();
}

function handleBlbPageSelectionKeyDown() {
  if (!pageButtonMonitoring) return;
  invalidateBlbPageSelectionButton();
}

function handleBlbPageSelectionMouseUp() {
  if (!pageButtonMonitoring) return;
  scheduleFinalBlbPageSelectionButtonUpdate();
}

function handleBlbPageSelectionKeyUp() {
  if (!pageButtonMonitoring) return;
  scheduleFinalBlbPageSelectionButtonUpdate();
}

const PAGE_BUTTON_HANDLERS_GUARD = '__blbSuitePageButtonHandlersV2';
function enableBlbPageButtonMonitoring() {
  if (pageButtonMonitoring || isBlbPageButtonExcludedSite() || isSensitiveSiteHostname(location.hostname) || !suiteEnabled) return;
  try {
    const previous = window[PAGE_BUTTON_HANDLERS_GUARD];
    if (previous && typeof previous === 'object') {
      for (const [eventName, handler] of Object.entries(previous)) {
        if (typeof handler === 'function') document.removeEventListener(eventName, handler, true);
      }
    }
    window[PAGE_BUTTON_HANDLERS_GUARD] = {
      mousedown: handleBlbPageSelectionMouseDown,
      keydown: handleBlbPageSelectionKeyDown,
      mouseup: handleBlbPageSelectionMouseUp,
      keyup: handleBlbPageSelectionKeyUp
    };
  } catch (_) {}
  pageButtonMonitoring = true;
  // The observer is armed by setBlbPageButtonVisible(true), not for the
  // entire time this feature is enabled.
  syncBlbPageSelectionDomObserver();
  document.addEventListener('mousedown', handleBlbPageSelectionMouseDown, true);
  document.addEventListener('keydown', handleBlbPageSelectionKeyDown, true);
  document.addEventListener('mouseup', handleBlbPageSelectionMouseUp, true);
  document.addEventListener('keyup', handleBlbPageSelectionKeyUp, true);
  addBlbPageSelectionButton();
  // Synchronize the native right-click item immediately with the same
  // site-based setting that controls this floating button. This prevents the
  // first right-click after page load from seeing stale visibility from the
  // previously active tab.
  safeRuntimeSendMessage({type:'blbSuiteSyncSelectionContextMenu'});
  // A fresh page must not inherit a stale right-click item from the previous
  // document. The floating button starts hidden until a valid selection exists.
  setBlbPageButtonVisible(false);
  // A selection can be made before asynchronous site settings finish loading,
  // while the page-button listeners are not attached yet. Reconcile the live
  // selection after monitoring starts so that an early mouseup is not lost.
  scheduleFinalBlbPageSelectionButtonUpdate();
}

function disableBlbPageButtonMonitoring() {
  pageButtonValidationToken++;
  stopBlbPageSelectionDomObserver();
  if (pageButtonSelectionFrame) {
    cancelAnimationFrame(pageButtonSelectionFrame);
    pageButtonSelectionFrame = 0;
  }
  if (pageButtonMonitoring) {
    document.removeEventListener('mousedown', handleBlbPageSelectionMouseDown, true);
    document.removeEventListener('keydown', handleBlbPageSelectionKeyDown, true);
    document.removeEventListener('mouseup', handleBlbPageSelectionMouseUp, true);
    document.removeEventListener('keyup', handleBlbPageSelectionKeyUp, true);
    pageButtonMonitoring = false;
  }
  removeBlbPageSelectionButton();
}

function getPageSelectionSiteKey() {
  let host = String(location.hostname || '').toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

function clearBlbPageSelectionAfterAction() {
  // Hide synchronously before clearing the native selection; otherwise the
  // selectionchange observer can briefly re-show the floating button.
  setBlbPageButtonVisible(false);
  blbPageButtonSelection = '';
  blbPageButtonContextualReference = null;
  blbPageButtonDirectUrl = null;
  lastSelectionContextualReference = null;
  lastSelectionContextualText = '';
  try { window.getSelection?.()?.removeAllRanges(); } catch (_) {}
}

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