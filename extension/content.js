(async function () {
const BLB_HOSTNAME = BLBShared.hostnames.blb;
const BLB_ORIGIN = BLBShared.urls.blbOrigin;
// Blue Letter Bible Suite 5.2.25 - unified content script

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
function parseRef(text) {
  const value=decodeSafe(text).trim();
  // Accept normal references and BiblePortal's dotted form, e.g.
  // John 3:16, John 3 16, and John.3.16.
  const m=value.match(/^(.+?)[\s.]+(\d+)(?:[:.\s]+(\d+)(?:-(\d+))?)?$/);
  return m ? {book:m[1].trim(),chapter:Number(m[2]),from:m[3]?Number(m[3]):1,to:m[4]?Number(m[4]):null} : null;
}

function redirectBibleSite() {
  const u=new URL(location.href), host=u.hostname.toLowerCase().replace(/^www\./,"");
  let ref=null;

  if (host==="bible.com") {
    // Ignore the selected translation/version completely. Any version clicked
    // on Bible.com is redirected to the KJV equivalent in BLB.
    const m=u.pathname.match(/^\/bible\/[^/]+\/([^./]+)\.(\d+)(?:\.(\d+)(?:-(\d+))?)?(?:\.[^/]+)?\/?$/i);
    if (m) ref={book:m[1],chapter:+m[2],from:m[3]?+m[3]:1,to:m[4]?+m[4]:null};
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

  if (host==="kjv.site") {
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
  const target=blbUrl(ref.book,ref.chapter,ref.from,ref.to);
  if (!target) return false;
  if (target!==u.href) { location.replace(target); return true; }
  return false;
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
  'bibleportal.com', 'kingjamesbibleonline.org', 'kjbo.org',
  'kjv.site', 'm.kjv.site', 'officialkingjamesbible.com',
  'webstersdictionary1828.com', BLB_HOSTNAME
]);

if (REDIRECT_HOSTS.has(location.hostname.toLowerCase().replace(/^www\./, ''))) {
  isSuiteEnabled().then(enabled => {
    if (!enabled) return;
    return chrome.storage.local.get({redirectEnabled:false}).then(({redirectEnabled})=>{
      if (!redirectEnabled) return;
      if (!redirectBlbNet()) redirectBibleSite();
    });
  }).catch(() => {});
}
// ---------- BLB MultiVerse native-copy hyperlink enhancement ----------
// Augment BLB's native MultiVerse clipboard operation with text/html.
// IMPORTANT: preserve BLB's native Copy button/payload while enriching the clipboard with HTML.
if (
  location.hostname === BLBShared.hostnames.blbWww &&
  /\/tools\/MultiVerse\.cfm$/i.test(location.pathname)
) {
  // Only enhance clipboard data when BLB's own Copy button initiates the copy.
  // A regular Ctrl+C (including copying text from the references textbox) must
  // retain the browser/BLB default behaviour.
  let nativeMultiVerseCopyPending = false;
  document.addEventListener("click", event => {
    const button = event.target?.closest?.("#copyButton, #copyByVerseButton");
    if (!button) return;
    nativeMultiVerseCopyPending = true;
    setTimeout(() => { nativeMultiVerseCopyPending = false; }, 0);
  }, true);

  document.addEventListener("copy", e => {
    if (!nativeMultiVerseCopyPending) return;
    nativeMultiVerseCopyPending = false;
    if (!suiteEnabled) return;
	if (!e.clipboardData) return;

    try {
      const buttons = Array.from(
        document.querySelectorAll("#copyButton, #copyByVerseButton")
      );

      const nativeButton = buttons.find(button => {
        const text = button.getAttribute("data-clipboard-text") || "";
        if (!text) return false;

        const style = window.getComputedStyle(button);
        return style.display !== "none" &&
          style.visibility !== "hidden";
      }) || buttons.find(button =>
        !!(button.getAttribute("data-clipboard-text") || "")
      );

      
	  const plain = nativeButton?.getAttribute("data-clipboard-text") || "";

if (!plain) return;

     const allLinks = Array.from(document.querySelectorAll("a[href]"));

const verseLinks = allLinks
  .map(a => {
    const href = a.href || "";
    const match = href.match(
      /^https:\/\/www\.blueletterbible\.org\/kjv\/([^/]+)\/(\d+)\/(\d+)(?:\/|$)/i
    );

    if (!match) return null;

    return {
      urlKey: String(match[1]).toLowerCase(),
      chapter: Number(match[2]),
      verse: Number(match[3]),
      href
    };
  })
  .filter(Boolean);

let html = plain
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\r?\n/g, "<br>");

// BLB emits compact numbered-book abbreviations in native copy text
// (e.g. "1Sa", "2Ki", "1Ch"). Allow digits inside the book token and
// allow the number prefix to touch the abbreviation, while retaining
// support for spaced forms such as "1 Samuel".
const referencePattern =
  /\(([1-3]\s*)?([A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z]+)*?)\s+(\d+):(\d+)(?:-\d+)?(?:\s+[^)]*)?\)/g;

let hyperlinkCount = 0;

html = html.replace(
  referencePattern,
  (whole, number, book, chapter, verse) => {
    const bookName = `${number || ""}${book}`.trim();

    const resolved = resolveBibleBook(bookName);

    const urlKey = String(resolved?.urlKey || "").toLowerCase();

    const match = verseLinks.find(link =>
      link.urlKey === urlKey &&
      link.chapter === Number(chapter) &&
      link.verse === Number(verse)
    );

    if (!match) return whole;

    hyperlinkCount++;

    return `<a href="${match.href}" style="color:#1155cc;text-decoration:underline;">${whole}</a>`;
  }
);

e.clipboardData.setData("text/plain", plain);
e.clipboardData.setData(
  "text/html",
  `<!DOCTYPE html><html><body><!--StartFragment--><span style="font-family:Arial,sans-serif;">${html}</span><!--EndFragment--></body></html>`
);
e.preventDefault();
} catch (_) {
      // Leave the native MultiVerse copy operation untouched if enhancement fails.
    }
  }, true);


}

// ---------- BLB Auto Hyperlinker ----------
function formatBlbTextToHtml(rawText) {
  const refs=rawText.match(/\b(?:[1-3]\s*|i{1,3}\s*)?[A-Za-z0-9.]+\s+\d+:\d+(?:-\d+)?\b/gi);
  if (!refs) return null;
  let html=rawText;
  refs.forEach(ref=>{
    const x=ref.trim(), i=x.lastIndexOf(" ");
    if (i<0) return;
    const book=x.slice(0,i).replace(/\./g,"").replace(/\s+/g,"");
    const cv=x.slice(i+1).replace(":","/");
    html=html.replace(ref,`<a href="${BLBShared.urls.blbHome}kjv/${book}/${cv}/" style="color:#1155cc;text-decoration:underline;">${ref}</a>`);
  });
  html=html.replace(/\n/g,"<br>");
  return `<!DOCTYPE html><html><body><!--StartFragment--><span style="font-family:Arial,sans-serif;">${html}</span><!--EndFragment--></body></html>`;
}

if (location.hostname.endsWith(BLB_HOSTNAME) &&
    !/(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)) {
  // The copy event must be handled synchronously. Awaiting storage state inside
  // the event handler lets the browser finish its normal copy operation before
  // preventDefault() runs, which loses the HTML clipboard payload used by
  // Word/Google Docs "Paste as link" behavior. The content script already
  // maintains suiteEnabled through storage.onChanged, so use that cached value.
  document.addEventListener("copy",e=>{
    if (!suiteEnabled) return;
    const text=window.getSelection()?.toString()||"";
    const html=formatBlbTextToHtml(text);
    if (!html || !e.clipboardData) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.clipboardData.setData("text/html",html);
    e.clipboardData.setData("text/plain",text);
  },true);

  if (navigator.clipboard?.writeText) {
    const original=navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText=async text=>{
      if (!(await isSuiteEnabled())) return original(text);
      const html=formatBlbTextToHtml(text);
      if (!html) return original(text);
      const handler=e=>{
        e.clipboardData.setData("text/html",html);
        e.clipboardData.setData("text/plain",text);
        e.preventDefault();
      };
      document.addEventListener("copy",handler,true);
      document.execCommand("copy");
      document.removeEventListener("copy",handler,true);
    };
  }

  // ---------- BLB Parsing Popup New Tab ----------
// Keep parsing-popup links working on both normal BLB verse pages and
// Criteria Search pages. A stable window name prevents repeated clicks from
// opening duplicate tabs; the same tab is reused for the same destination.
if (location.hostname.endsWith(BLB_HOSTNAME)) {
  const handleParsePopupLink = link => {
    if (!link || !link.href || !link.closest?.(".parse-popup")) return;
    if (link.dataset.blbSuitePopup) return;
    link.dataset.blbSuitePopup = "1";
    link.addEventListener("click", e => {
      if (!suiteEnabled || isModifiedLinkActivation(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();

      openBlbDestinationFromContent(link.href);

      const m = link.href.match(/lexicon\/(g|h)\d+/i);
      if (m) {
        const criteriaUrl =
          `${BLBShared.urls.blbSearch}?Criteria=${m[0].split("/").pop()}`;
        openBlbDestinationFromContent(criteriaUrl);
      }
    }, true);
  };

  const processParsePopups = (root = document) => {
    if (!suiteEnabled) return;
    if (root.matches?.(".parse-popup")) handleParsePopupLink(root);
    root.querySelectorAll?.(".parse-popup a[href]").forEach(handleParsePopupLink);
  };

  const parsePopupObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) processParsePopups(node);
      }
    }
  });
  parsePopupObserver.observe(document.documentElement, {childList:true, subtree:true});
  processParsePopups();
}

// ---------- BLB New Tab ----------
  function modifyLinks(container) {
    container.querySelectorAll("a").forEach(link=>{
      if (!link.href) return;
      if (link.closest(".parse-popup")) {
        // Parsing-popup links are handled by the shared BLB parse-popup handler
        // below so Criteria Search pages and normal verse pages use the same
        // single-tab/reuse behavior.
      } else if (link.closest('div[id^="bVerse_"]')) {
        link.target="_blank";
      }
    });
  }

  function modifyMultiVerseLinks() {
    if (!location.href.includes("MultiVerse.cfm")) return;
    document.querySelectorAll('a[href*="/kjv/"]').forEach(a=>a.target="_blank");
  }

  const process=(root=document)=>{
    if (!suiteEnabled) return;
    if (root.matches?.('div[id^="bVerse_"], .parse-popup')) modifyLinks(root);
    root.querySelectorAll?.('div[id^="bVerse_"], .parse-popup').forEach(modifyLinks);
    if (location.href.includes("MultiVerse.cfm")) {
      if (root.matches?.('a[href*="/kjv/"]')) root.target="_blank";
      root.querySelectorAll?.('a[href*="/kjv/"]').forEach(a=>a.target="_blank");
    }
  };
  let processScheduled=false;
  const pendingRoots=[];
  const scheduleProcess=(root=null)=>{
    if (root) pendingRoots.push(root);
    if (processScheduled) return;
    processScheduled=true;
    requestAnimationFrame(()=>{
      processScheduled=false;
      if (!suiteEnabled) { pendingRoots.length=0; return; }
      if (!pendingRoots.length) { process(); return; }
      const roots=pendingRoots.splice(0,pendingRoots.length);
      const seen=new Set();
      for (const root of roots) {
        if (!root || seen.has(root) || !root.isConnected) continue;
        seen.add(root);
        process(root);
      }
    });
  };
  const observer=new MutationObserver(mutations=>{
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType===1) scheduleProcess(node);
      }
    }
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener("click",e=>{
    if (!suiteEnabled || isModifiedLinkActivation(e)) return;
    const a=e.target.closest?.("a.nowrap");
    if (!a) return;

    // Criteria Search owns ordinary KJV verse links below. Let its dedicated
    // handler below be the sole Suite owner for those links.
    if (
      location.pathname.toLowerCase() === "/search/search.cfm" &&
      /\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(a.href)
    ) return;

    e.preventDefault(); e.stopImmediatePropagation(); openBlbDestinationFromContent(a.href);
  },true);
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",process);
  else process();
}

// ---------- BLB MultiVerse Tool View ----------
// MultiVerse is intentionally outside the normal BLB New Tab exclusion block.
// Own KJV verse navigation here so native _blank handling cannot create duplicates.
if (
  location.hostname.endsWith(BLB_HOSTNAME) &&
  /\/tools\/MultiVerse\.cfm$/i.test(location.pathname)
) {
  document.addEventListener("click", e => {
    if (!suiteEnabled || isModifiedLinkActivation(e)) return;
    const link = e.target.closest?.('a[href*="/kjv/"]');
    if (!link || !link.href) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void safeRuntimeSendMessage({
      type: 'blbSuiteOpenMultiVerseVerse',
      url: link.href
    });
  }, true);
}

// ---------- BLB Criteria Search parsing-popup bridge ----------
// Criteria Search is excluded from the normal BLB New Tab block above because
// its page has its own navigation handlers. Handle only its parsing-popup
// links here, using the same stable popup naming as normal BLB verse pages.
// Do not intercept ordinary Criteria Search links.
if (
  location.hostname.endsWith(BLB_HOSTNAME) &&
  location.pathname.toLowerCase() === "/search/search.cfm"
) {
  document.addEventListener("click", e => {
    if (!suiteEnabled || isModifiedLinkActivation(e)) return;

    const link = e.target.closest?.(".parse-popup a[href], a.parse-popup[href]");
    if (!link) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    openBlbDestinationFromContent(link.href);

    const lowerHref = link.href.toLowerCase();
    const lexiconIndex = lowerHref.indexOf("/lexicon/");
    if (lexiconIndex < 0) return;

    const tail = link.href.slice(lexiconIndex + "/lexicon/".length);
    const strong = tail.split(/[?#/]/)[0];
    if (!/^[gh]\d+$/i.test(strong)) return;

    const criteriaUrl =
      "https://www.blueletterbible.org/search/search.cfm?Criteria=" +
      encodeURIComponent(strong);

    openBlbDestinationFromContent(criteriaUrl);
  }, true);
}

// ---------- BLB Criteria Search ordinary verse links ----------
// Criteria Search result verses are Suite-owned new-tab actions. Keep them
// separate from the broad nowrap handler so each click has exactly one owner.
if (
  location.hostname.endsWith(BLB_HOSTNAME) &&
  location.pathname.toLowerCase() === "/search/search.cfm"
) {
  document.addEventListener("click", e => {
    if (!suiteEnabled || isModifiedLinkActivation(e)) return;

    const link = e.target.closest?.('a[href]');
    if (!link || link.closest?.(".parse-popup")) return;
    if (!/\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    openBlbDestinationFromContent(link.href);
  }, true);
}

// ---------- BLB passive New Tab targets for dynamic/native verse links ----------
// Keep this separate from the existing copy/hyperlink handler.  Do not cancel
// native BLB clicks; only supply target="_blank" to verse links that BLB adds
// dynamically or places outside the older bVerse_ containers.
if (location.hostname.endsWith(BLB_HOSTNAME)) {
  const applyPassiveNewTabTargets = (root=document) => {
    if (!suiteEnabled) return;
    const apply = link => {
      if (!link || !link.href) return;
      if (/\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href)) {
        link.target="_blank";
      }
    };
    if (root.matches?.("a[href]")) apply(root);
    root.querySelectorAll?.("a[href]").forEach(apply);
  };

  const schedulePassiveNewTabTargets = (() => {
    let scheduled=false;
    const pending=[];
    return (root=null) => {
      if (root) pending.push(root);
      if (scheduled) return;
      scheduled=true;
      requestAnimationFrame(() => {
        scheduled=false;
        if (!suiteEnabled) { pending.length=0; return; }
        if (!pending.length) {
          applyPassiveNewTabTargets();
          return;
        }
        const roots=pending.splice(0,pending.length);
        const seen=new Set();
        for (const root of roots) {
          if (!root || seen.has(root) || !root.isConnected) continue;
          seen.add(root);
          applyPassiveNewTabTargets(root);
        }
      });
    };
  })();

  const passiveNewTabObserver=new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType===1) schedulePassiveNewTabTargets(node);
      }
    }
  });
  passiveNewTabObserver.observe(document.documentElement,{childList:true,subtree:true});

  if (document.readyState==="loading") {
    document.addEventListener("DOMContentLoaded",() => schedulePassiveNewTabTargets());
  } else {
    schedulePassiveNewTabTargets();
  }
}

// ---------- Webster's 1828 ----------
if (location.hostname==="webstersdictionary1828.com") {
  async function captureWebsterWord() {
    try {
      if (!(await isSuiteEnabled())) return;
      const active = await chrome.runtime.sendMessage({type:'blbSuiteStudyCaptureActive'});
      if (!active?.active) return;
      const parts = location.pathname.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0].toLowerCase() !== 'dictionary') return;
      const word = normalizeSelectionText(decodeURIComponent(parts[1]).replace(/[-_]+/g,' '));
      if (!word || /^(search|index|browse|title-page)$/i.test(word)) return;
      await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudySearchTerm', term:word});
    } catch (_) {}
  }
  captureWebsterWord();

  function collectWebsterBibleRefs() {
    const refs=[];
    const seen=new Set();
    document.querySelectorAll("a.bible").forEach(a=>{
      const ref=parseRef(normalizeSelectionText(a.innerText||a.textContent||""));
      if (!ref) return;
      const target=blbUrl(ref.book,ref.chapter,ref.from,ref.to);
      if (!target || seen.has(target)) return;
      seen.add(target);
      refs.push({book:ref.book,chapter:ref.chapter,from:ref.from,to:ref.to,text:normalizeSelectionText(a.innerText||a.textContent||""),url:target});
    });
    return refs;
  }

  function showWebsterStatus(message, isError=false) {
    let box=document.getElementById("blb-suite-webster-status");
    if (!box) {
      box=document.createElement("div");
      box.id="blb-suite-webster-status";
      box.style.cssText="position:fixed;right:18px;bottom:72px;z-index:2147483647;background:#fff;border:1px solid #bbb;border-radius:6px;padding:9px 12px;font:13px Arial,sans-serif;color:#222;box-shadow:0 2px 10px rgba(0,0,0,.18);";
      document.body.appendChild(box);
    }
    box.textContent=message;
    box.style.color=isError ? "#b00020" : "#222";
    clearTimeout(box._timer);
    box._timer=setTimeout(()=>box.remove(),3500);
  }

  function openAllWebsterRefs() {
    const refs=collectWebsterBibleRefs();
    if (!refs.length) {
      showWebsterStatus("No Bible references found on this page.", true);
      return;
    }
    if (refs.length === 1) {
      // A single Webster reference is opened directly by the background tab manager.
      // Do not display a client-side failure toast here: the tab operation can succeed
      // even when the one-shot response channel closes before the content script
      // receives its acknowledgement.
      chrome.runtime.sendMessage({
        type:'blbSuiteOpenBackgroundUrl',
        url:refs[0].url,
        activeIfNew:true,
        activateExisting:true
      }).catch(()=>{});
      return;
    }
    chrome.runtime.sendMessage({type:'blbSuiteOpenWebsterMultiVerse', refs}).then(response=>{
      if (!response?.ok) {
        showWebsterStatus("Unable to open BLB MultiVerse.", true);
        return;
      }
      showWebsterStatus(`Opening ${refs.length} Bible references in BLB MultiVerse…`);
    }).catch(()=>showWebsterStatus("Unable to open BLB MultiVerse.", true));
  }

  async function addWebsterMultiVerseButton() {
    if (!(await isSuiteEnabled())) return;
    if (!document.body || document.getElementById("blb-suite-webster-multiverse")) return;
    const mount=document.body || document.documentElement;
    if (!mount) return;
    const button=document.createElement("button");
    button.id="blb-suite-webster-multiverse";
    button.type="button";
    button.textContent="Open Bible References in BLB";
    button.title="Collect all Bible-reference links on this Webster's 1828 page and open them together in BLB MultiVerse.";
    button.style.cssText="position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#292a2d;color:#f1f3f4;border:1px solid #505257;border-radius:7px;padding:10px 13px;font:600 13px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .12s ease,box-shadow .12s ease,background .12s ease;"; button.addEventListener("mouseenter",()=>{button.style.background="#303136";button.style.transform="translateY(-1px)";button.style.boxShadow="0 4px 12px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.1)";}); button.addEventListener("mouseleave",()=>{button.style.background="#292a2d";button.style.transform="translateY(0)";button.style.boxShadow="0 2px 8px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08)";}); button.addEventListener("mousedown",()=>{button.style.transform="translateY(1px)";button.style.boxShadow="0 1px 3px rgba(0,0,0,.38),inset 0 1px 2px rgba(0,0,0,.22)";}); button.addEventListener("mouseup",()=>{button.style.transform="translateY(-1px)";button.style.boxShadow="0 4px 12px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.1)";});
    button.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();openAllWebsterRefs();});
    mount.appendChild(button);
  }

  // Global external redirects default OFF. Keep this handler fail-closed when storage is empty or unavailable.
  let websterRedirectEnabled = false;
  chrome.storage.local.get({redirectEnabled:false}).then(data=>{
    websterRedirectEnabled = data.redirectEnabled !== false;
  }).catch(()=>{});

  document.addEventListener("click",e=>{
    if (!suiteEnabled || !websterRedirectEnabled || isModifiedLinkActivation(e)) return;
    const a=e.target.closest?.("a.bible");
    if (!a) return;
    const ref=parseRef(normalizeSelectionText(a.innerText||a.textContent||""));
    if (!ref) return;
    const target=blbUrl(ref.book,ref.chapter,ref.from,ref.to);
    if (!target) return;
    e.preventDefault(); e.stopImmediatePropagation();
    chrome.runtime.sendMessage({
      type:'blbSuiteOpenBackgroundUrl',
      url:target,
      activeIfNew:true,
      activateExisting:true
    }).catch(()=>{});
  },true);

  // Webster pages can restore/rebuild their body during a normal refresh.
  // Retry after DOM readiness so the button is present without requiring a
  // hard refresh. The duplicate guard inside addWebsterMultiVerseButton()
  // keeps these retries harmless.
  const ensureWebsterButton=()=>{
    if (!suiteEnabled) return;
    addWebsterMultiVerseButton().catch(()=>{});
  };
  if (document.readyState==="loading") {
    document.addEventListener("DOMContentLoaded",ensureWebsterButton,{once:true});
  } else {
    ensureWebsterButton();
  }
  setTimeout(ensureWebsterButton,250);
  setTimeout(ensureWebsterButton,1000);
  setTimeout(ensureWebsterButton,2000);
  let websterButtonCheckScheduled=false;
  const scheduleWebsterButtonCheck=()=>{
    if (websterButtonCheckScheduled) return;
    websterButtonCheckScheduled=true;
    requestAnimationFrame(()=>{
      websterButtonCheckScheduled=false;
      if (!document.getElementById("blb-suite-webster-multiverse")) ensureWebsterButton();
    });
  };
  // Only watch direct document-element changes so we can recover if the page
  // replaces its <body>. Watching the entire Webster DOM is unnecessary and
  // would wake the extension for unrelated page mutations.
  const websterBodyObserver=new MutationObserver(scheduleWebsterButtonCheck);
  const startWebsterObserver=()=>{
    if (document.documentElement) websterBodyObserver.observe(document.documentElement,{childList:true});
  };
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",startWebsterObserver,{once:true});
  else startWebsterObserver();
}

// ---------- BLB MultiVerse hand-off ----------
// Suite-generated MultiVerse tabs must never expose BLB's bootstrap/default
// result set. Keep the document hidden until the requested reference set is
// actually visible after Retrieve has completed.
if (location.hostname===BLBShared.hostnames.blbWww &&
    /(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)/i.test(location.pathname) &&
    /[?&]blbSuiteMultiVerse=1(?:&|$)/i.test(location.search)) {
  let multiverseHandoffHidden=false;
  let multiverseRevealTimer=0;

  const revealPendingMultiVerseView=()=>{
    if (!multiverseHandoffHidden) return;
    multiverseHandoffHidden=false;
    try {
      document.documentElement.style.visibility='';
      delete document.documentElement.dataset.blbSuiteMultiVersePending;
    } catch (_) {}
    if (multiverseRevealTimer) {
      clearTimeout(multiverseRevealTimer);
      multiverseRevealTimer=0;
    }
  };

  const hidePendingMultiVerseView=()=>{
    if (multiverseHandoffHidden) return;
    try {
      document.documentElement.dataset.blbSuiteMultiVersePending='1';
      document.documentElement.style.visibility='hidden';
      multiverseHandoffHidden=true;
      multiverseRevealTimer=window.setTimeout(revealPendingMultiVerseView,10000);
    } catch (_) {}
  };

  const hasExpectedMultiVerseResults=(refs)=>{
    try {
      const expected=refs.map(ref=>{
        const book=resolveBibleBook(ref.book);
        if (!book) return null;
        return {urlKey:String(book.urlKey||'').toLowerCase(),chapter:Number(ref.chapter),from:ref.from==null?null:Number(ref.from)};
      }).filter(Boolean);
      if (expected.length!==refs.length) return false;

      const links=Array.from(document.querySelectorAll('a[href*="/kjv/"]'));
      if (!links.length) return false;
      return expected.every(want=>links.some(link=>{
        try {
          const path=new URL(link.href,location.href).pathname;
          const m=path.match(/^\/kjv\/([^/]+)\/(\d+)\/(\d+)(?:-\d+)?\/?$/i);
          if (!m) return false;
          if (m[1].toLowerCase()!==want.urlKey || Number(m[2])!==want.chapter) return false;
          return want.from==null || Number(m[3])===want.from;
        } catch (_) { return false; }
      }));
    } catch (_) {
      return false;
    }
  };

  async function waitForExpectedMultiVerseResults(refs){
    const started=Date.now();
    while (Date.now()-started<10000) {
      if (hasExpectedMultiVerseResults(refs)) return true;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return false;
  }

  async function processPendingMultiVerseRefs() {
    if (!(await isSuiteEnabled())) {
      revealPendingMultiVerseView();
      return false;
    }
    hidePendingMultiVerseView();
    const response=await chrome.runtime.sendMessage({type:'blbSuiteGetPendingMultiVerseRefs'});
    const refs=response?.refs;
    if (!Array.isArray(refs) || refs.length<1) {
      revealPendingMultiVerseView();
      return false;
    }

    const values=refs.map(r=>`${r.book} ${r.chapter}:${r.from}${r.to && r.to!==r.from ? "-"+r.to : ""}`);
    const combined=values.join("; ");

    const started=Date.now();
    let heading=null, advancedHeading=null, verseControls=[], retrieve=null;
    while (Date.now()-started<4000) {
      heading=Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,td,th,label"))
        .find(el=>/^\s*multiverse retrieval\s*$/i.test((el.innerText||el.textContent||"").trim()));
      if (heading) {
        advancedHeading=Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,td,th,label"))
          .find(el=>/^\s*advanced multiverse search options\s*$/i.test((el.innerText||el.textContent||"").trim()));
        const allControls=Array.from(document.querySelectorAll("input[type=text], textarea, input:not([type])"));
        const beforeAdvanced=el=>!advancedHeading || !!(advancedHeading.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_PRECEDING);
        const afterHeading=el=>!!(heading.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING);
        verseControls=allControls.filter(el=>afterHeading(el)&&beforeAdvanced(el)).slice(0,10);
        retrieve=Array.from(document.querySelectorAll("button,input[type=submit],input[type=button],a"))
          .find(x=>/^\s*retrieve\s*$/i.test((x.innerText||x.value||"").trim()) &&
            (!advancedHeading || !!(advancedHeading.compareDocumentPosition(x)&Node.DOCUMENT_POSITION_PRECEDING)));
        if (verseControls.length&&retrieve) break;
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }

    if (!verseControls.length||!retrieve) {
      revealPendingMultiVerseView();
      return false;
    }

    const setNativeValue=(el,value)=>{
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;
      if (setter) setter.call(el,value); else el.value=value;
      for (const type of ["input","change","keyup","blur"]) el.dispatchEvent(new Event(type,{bubbles:true}));
    };

    verseControls.forEach(c=>setNativeValue(c,""));
    const primary=verseControls[0];
    if (!combined||!primary) {
      revealPendingMultiVerseView();
      return false;
    }
    setNativeValue(primary,combined);
    primary.setAttribute("value",combined);

    const valueStarted=Date.now();
    let actual="";
    while (Date.now()-valueStarted<1000) {
      actual=String(primary.value||primary.getAttribute("value")||"").trim();
      if (actual===combined) break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    if (actual!==combined) {
      revealPendingMultiVerseView();
      return false;
    }

    await chrome.runtime.sendMessage({type:'blbSuiteConsumePendingMultiVerseRefs'}).catch(()=>{});
    retrieve.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,view:window}));
    retrieve.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,cancelable:true,view:window}));
    retrieve.click();

    // Do not reveal merely because Retrieve was clicked. BLB updates the result
    // area asynchronously; reveal only after the requested references are
    // actually present, so the normal bootstrap/default verses cannot flash.
    await waitForExpectedMultiVerseResults(refs);
    revealPendingMultiVerseView();
    return true;
  }

  const tryProcess=()=>processPendingMultiVerseRefs().catch(()=>revealPendingMultiVerseView());
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",tryProcess,{once:true});
  else void tryProcess();
}


// // ---------- Study reference capture ----------
// Capture only useful BLB Bible/Strong's destinations while a named Study Topic
// is active. This is deliberately navigation/result based: no click logging,
// polling, or page-wide MutationObserver is used for the audit.
if (location.hostname.toLowerCase().replace(/^www\./,'') === BLB_HOSTNAME) {
  const captureStudyRefs = async () => {
    try {
      if (!(await isSuiteEnabled())) return;
      const active = await chrome.runtime.sendMessage({type:'blbSuiteStudyCaptureActive'});
      if (!active?.active) return;

      const refs = new Map();
      const addUrl = href => {
        try {
          const u = new URL(String(href || ''), location.href);
          const host = u.hostname.toLowerCase().replace(/^www\./,'');
          if (host !== BLB_HOSTNAME) return;
          const parts = u.pathname.split('/').filter(Boolean);
          if (parts.length < 3 || parts[0].toLowerCase() !== 'kjv' || !/^\d+$/.test(parts[2])) return;
          // Verse/result links have a verse component. Chapter links are handled
          // from the current page URL only, so navigation menus do not pollute
          // search-result capture.
          if (parts.length < 4) return;
          const vm = String(parts[3]).match(/^(\d+)(?:-(\d+))?$/);
          if (!vm) return;
          const key = `${parts[1].toLowerCase()}|${parts[2]}|${vm[1]}|${vm[2] || vm[1]}`;
          refs.set(key,{urlKey:parts[1].toLowerCase(),chapter:Number(parts[2]),from:Number(vm[1]),to:Number(vm[2] || vm[1]),version:'kjv'});
        } catch (_) {}
      };

      // Native BLB Search: record only the search term, never the potentially
      // enormous set of verses returned by the search.
      if (/\/search\/(?:search|preSearch)\.cfm/i.test(location.pathname)) {
        const currentUrl = new URL(location.href);
        // MultiVerse intentionally opens BLB's search page with a temporary
        // default Criteria=Jesus before populating the real MultiVerse inputs.
        // That bootstrap term is not a user search and must never enter Study
        // History.
        if (currentUrl.searchParams.get('blbSuiteMultiVerse') === '1') return;
        const criteria = normalizeSelectionText(String(currentUrl.searchParams.get('Criteria') || '').replace(/\+/g, ' '));
        if (criteria) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudySearchTerm', term:criteria});
        return;
      }

      // Current Bible page / redirected Bible page only. Search and MultiVerse
      // result lists are deliberately not bulk-captured.
      addUrl(location.href);
      if (refs.size) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudyRefs', refs:[...refs.values()]});
    } catch (_) {}
  };

  const captureStrong = async () => {
    try {
      if (!(await isSuiteEnabled())) return;
      const active = await chrome.runtime.sendMessage({type:'blbSuiteStudyCaptureActive'});
      if (!active?.active) return;
      const m = location.pathname.match(/\/lexicon\/(g|h)(\d+)\//i);
      if (m) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudyStrong', value:`${m[1]}${m[2]}`});
    } catch (_) {}
  };

  const runStudyCapture = () => { captureStudyRefs(); captureStrong(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',runStudyCapture,{once:true});
  else runStudyCapture();
}

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
    const refs = resolveBibleReferenceText(source);
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
        const selection=getDoubleClickSelection(event);
        if (!selection) {
          if (Date.now()-started<1500) requestAnimationFrame(dispatch);
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
          if (!isBibleVersionCode && !isKjvWord && !isBookName) return true;
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
        const isPrefixedBookName=hasNumericPrefix && !!resolveBibleBook(selection);
        const isBookName=!hasNumericPrefix && !!resolveBibleBook(selection);
        const contextualTarget=getDoubleClickTargetElement(event)||event.target;

        // A suffix such as "Peter" may be part of a numbered book name.
        // Check the nearest text block for a valid 1/2/3 prefix before
        // invoking the full DOM reference parser. Invalid/missing prefixes
        // therefore do not trigger the expensive contextual scan.
        const possibleNumberedBookSuffix=/^(?:Samuel|Kings|Chronicles|Corinthians|Thessalonians|Timothy|Peter|John)$/i.test(selection);
        let hasValidNearbyBookPrefix=false;
        if (possibleNumberedBookSuffix && !hasNumericPrefix) {
          try {
            const contextNode=contextualTarget instanceof Element
              ? (contextualTarget.closest('p,li,td,th,blockquote,article,section,div')||contextualTarget.parentElement||contextualTarget)
              : (event.target?.parentElement||event.target);
            const contextText=normalizeSelectionText(contextNode?.textContent||'');
            const match=contextText.match(/(?:^|[^A-Za-z0-9])([1-3])\s+(Samuel|Kings|Chronicles|Corinthians|Thessalonians|Timothy|Peter|John)\b/i);
            hasValidNearbyBookPrefix=!!(match
              && match[2].toLowerCase()===selection.toLowerCase()
              && resolveBibleBook(match[1]+' '+match[2]));
          } catch (_) {}
        }
        const needsDomContext=isNumericBookCandidate||isBookName||isPrefixedBookName||hasValidNearbyBookPrefix||isBibleVersionCode||isReferenceDashGesture;
        const blockContext=needsDomContext
          ? getDoubleClickBlockContextReference(selection,contextualTarget,event)
          : null;

        // Wait for the native selection/context to settle only for a number
        // that could be a standalone book number or part of a Bible reference.
        if (isNumericBookCandidate && !blockContext && Date.now()-started<1500) {
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
        const contextualReference=isStandaloneNumericBook ? standaloneBook : (blockContext||standaloneBook);
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
  document.getElementById(BLB_PAGE_BUTTON_ID)?.remove();
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
    'position:fixed !important','right:20px !important',buttonBottom + ' !important','z-index:2147483647 !important','max-width:calc(100vw - 40px) !important',
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
  if (event?.target instanceof Element && event.target.closest(`#${BLB_PAGE_BUTTON_ID}`)) return;
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

  if (changes.masterEnabled) {
    suiteEnabled = changes.masterEnabled.newValue !== false;
    if (!suiteEnabled) {
      document.getElementById('blb-suite-webster-multiverse')?.remove();
      document.getElementById('blb-suite-webster-status')?.remove();
      disableBlbPageButtonMonitoring();
    } else {
      if (location.hostname === 'webstersdictionary1828.com') ensureWebsterButton?.();
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