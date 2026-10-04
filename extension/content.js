(async function () {
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

let suiteEnabled = true;
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
  suiteEnabled = true;
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
      // The filename repeats the chapter, e.g. John-3-16.html or
      // John-3-16-18.html. Match the chapter explicitly so the first
      // captured number is the verse, not the chapter.
      const vm=u.pathname.match(new RegExp("-"+p[1]+"-(\\d+)(?:-(\\d+))?\\.html$", "i"));
      ref={book:p[0],chapter:+p[1],from:vm?+vm[1]:1,to:vm&&vm[2]?+vm[2]:null};
    }
  }

  if (host==="biblehub.com") {
    const m=u.pathname.match(/^\/([^/]+)\/(\d+)(?:-(\d+)(?:-(\d+))?)?\.htm$/i);
    if (m) ref={book:m[1],chapter:+m[2],from:m[3]?+m[3]:1,to:m[4]?+m[4]:null};
  }

  if (host==="kingjamesbibleonline.org" || host==="kjbo.org") {
    let m=u.pathname.match(/^\/([^/]+)-Chapter-(\d+)\/?$/i);
    if (m) ref={book:m[1],chapter:+m[2],from:1,to:null};
    else {
      m=u.pathname.match(/^\/([^/]+)-(\d+)-(\d+)(?:-(\d+))?\/?$/i);
      if (m) ref={book:m[1],chapter:+m[2],from:+m[3],to:m[4]?+m[4]:null};
    }
  }

  if (host==="kjv.site") {
    // KJV.site uses /Book-11-kjv/ for a chapter page and may also use
    // /Book-11-16-kjv/ for a verse. Always ignore the source version
    // and redirect the corresponding passage to BLB KJV.
    let m=u.pathname.match(/^\/([^/]+)-(\d+)-kjv\/?$/i);
    if (m) ref={book:m[1],chapter:+m[2],from:1,to:null};
    else {
      m=u.pathname.match(/^\/([^/]+)-(\d+)-(\d+)(?:-(\d+))?-kjv\/?$/i);
      if (m) ref={book:m[1],chapter:+m[2],from:+m[3],to:m[4]?+m[4]:null};
    }
  }

  if (host==="officialkingjamesbible.com") {
    // OfficialKingJamesBible.com uses /bible/<book>/<chapter>.
    // It is a KJV site, so send the same passage to BLB KJV.
    const m=u.pathname.match(/^\/bible\/([^/]+)\/(\d+)\/?$/i);
    if (m) ref={book:m[1],chapter:+m[2],from:1,to:null};
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
  if (location.hostname!=="www.blueletterbible.org") return false;
  const m=location.pathname.match(/^\/net\/([^/]+)\/([^/]+)\/([^/]+)(?:-([^/]+))?\/s_\d+\/?$/i);
  if (!m) return false;
  const target=m[4]
    ? `https://www.blueletterbible.org/kjv/${m[1].toLowerCase()}/${m[2]}/${m[3].toLowerCase()}-${m[4].toLowerCase()}/`
    : `https://www.blueletterbible.org/kjv/${m[1].toLowerCase()}/${m[2]}/${m[3].toLowerCase()}/`;
  location.replace(target); return true;
}

const REDIRECT_HOSTS = new Set([
  'www.bible.com', 'www.biblegateway.com', 'www.bibleref.com', 'biblehub.com',
  'www.biblehub.com', 'bibleportal.com', 'www.bibleportal.com',
  'www.kingjamesbibleonline.org', 'kjbo.org', 'www.kjbo.org',
  'www.kjv.site', 'kjv.site', 'm.kjv.site',
  'officialkingjamesbible.com', 'www.officialkingjamesbible.com',
  'webstersdictionary1828.com', 'www.blueletterbible.org'
]);

if (REDIRECT_HOSTS.has(location.hostname.toLowerCase())) {
  chrome.storage.local.get({redirectEnabled:true}).then(({redirectEnabled})=>{
    if (!suiteEnabled || !redirectEnabled) return;
    if (!redirectBlbNet()) redirectBibleSite();
  });
}
// ---------- BLB MultiVerse native-copy hyperlink enhancement ----------
// Augment BLB's native MultiVerse clipboard operation with text/html.
// IMPORTANT: preserve BLB's native Copy button/payload while enriching the clipboard with HTML.
if (
  location.hostname === "www.blueletterbible.org" &&
  /\/tools\/MultiVerse\.cfm$/i.test(location.pathname)
) {
  document.addEventListener("copy", e => {
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

console.log("[BLB Suite] MultiVerse hyperlink diagnostic:", {
  suiteEnabled,
  nativeButton: nativeButton?.id || null,
  plainLength: plain.length,
  plain
});

if (!plain) return;

     console.log("[BLB Suite] MultiVerse hyperlink stage 1: starting");

const allLinks = Array.from(document.querySelectorAll("a[href]"));

console.log("[BLB Suite] MultiVerse hyperlink stage 2: links found", {
  total: allLinks.length
});

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

console.log("[BLB Suite] MultiVerse hyperlink stage 3: verse links", {
  count: verseLinks.length,
  verseLinks
});

let html = plain
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\r?\n/g, "<br>");

console.log("[BLB Suite] MultiVerse hyperlink stage 4: HTML created");

const referencePattern =
  /\(([1-3]\s+)?([A-Za-z]+(?:\s+[A-Za-z]+)*?)\s+(\d+):(\d+)(?:-\d+)?(?:\s+[^)]*)?\)/g;

let hyperlinkCount = 0;

html = html.replace(
  referencePattern,
  (whole, number, book, chapter, verse) => {
    console.log("[BLB Suite] MultiVerse hyperlink stage 5: reference", {
      whole,
      number,
      book,
      chapter,
      verse
    });

    const bookName = `${number || ""}${book}`.trim();

    const resolved = resolveBibleBook(bookName);

    console.log("[BLB Suite] MultiVerse hyperlink stage 6: resolved", {
      bookName,
      resolved
    });

    const urlKey = String(resolved?.urlKey || "").toLowerCase();

    const match = verseLinks.find(link =>
      link.urlKey === urlKey &&
      link.chapter === Number(chapter) &&
      link.verse === Number(verse)
    );

    console.log("[BLB Suite] MultiVerse hyperlink stage 7: match", {
      urlKey,
      match
    });

    if (!match) return whole;

    hyperlinkCount++;

    return `<a href="${match.href}" style="color:#1155cc;text-decoration:underline;">${whole}</a>`;
  }
);

console.log("[BLB Suite] MultiVerse hyperlink stage 8: complete", {
  hyperlinkCount,
  html
});
e.clipboardData.setData("text/plain", plain);
e.clipboardData.setData(
  "text/html",
  `<!DOCTYPE html><html><body><!--StartFragment--><span style="font-family:Arial,sans-serif;">${html}</span><!--EndFragment--></body></html>`
);
e.preventDefault();
console.log("[BLB Suite] MultiVerse clipboard AFTER setData:", {
  types: Array.from(e.clipboardData.types),
  html: e.clipboardData.getData("text/html"),
  htmlLength: e.clipboardData.getData("text/html").length
});

console.log("[BLB Suite] MultiVerse hyperlink stage 9: HTML written");
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
    html=html.replace(ref,`<a href="https://www.blueletterbible.org/kjv/${book}/${cv}/" style="color:#1155cc;text-decoration:underline;">${ref}</a>`);
  });
  html=html.replace(/\n/g,"<br>");
  return `<!DOCTYPE html><html><body><!--StartFragment--><span style="font-family:Arial,sans-serif;">${html}</span><!--EndFragment--></body></html>`;
}

if (location.hostname.endsWith("blueletterbible.org")) {
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

  if (!/(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)) {
  // ---------- BLB New Tab ----------
  function modifyLinks(container) {
    container.querySelectorAll("a").forEach(link=>{
      if (!link.href) return;
      if (link.closest(".parse-popup")) {
        if (link.dataset.blbSuitePopup) return;
        link.dataset.blbSuitePopup="1";
        link.addEventListener("click",e=>{
          e.preventDefault(); e.stopPropagation();
          window.open(link.href,"_blank");
          const m=link.href.match(/lexicon\/(g|h)\d+/i);
          if (m) window.open(`https://www.blueletterbible.org/search/search.cfm?Criteria=${m[0].split("/").pop()}`,"_blank");
        });
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

    // MutationObserver can receive the newly-created <a> itself rather than
    // its containing popup/verse block. Process that anchor through its
    // relevant ancestor so dynamically inserted BLB links get the same
    // New Tab treatment as links present during the initial scan.
    if (root.matches?.("a[href]")) {
      const container = root.closest?.('div[id^="bVerse_"], .parse-popup');
      if (container) modifyLinks(container);
    }

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
    if (!suiteEnabled) return;
    const a=e.target.closest?.("a.nowrap");
    if (!a) return;
    e.preventDefault(); e.stopImmediatePropagation(); window.open(a.href,"_blank");
  },true);
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",process);
  else process();
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

  let websterRedirectEnabled = true;
  chrome.storage.local.get({redirectEnabled:true}).then(data=>{
    websterRedirectEnabled = data.redirectEnabled !== false;
  }).catch(()=>{});

  document.addEventListener("click",e=>{
    if (!suiteEnabled || !websterRedirectEnabled) return;
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
if (location.hostname==="www.blueletterbible.org" &&
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
    hidePendingMultiVerseView();
    if (!(await isSuiteEnabled())) {
      revealPendingMultiVerseView();
      return false;
    }
    const response=await chrome.runtime.sendMessage({type:'blbSuiteGetPendingMultiVerseRefs'});
    const refs=response?.refs;
    if (!Array.isArray(refs) || refs.length<2) {
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
if (location.hostname.toLowerCase().replace(/^www\./,'') === 'blueletterbible.org') {
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
          if (host !== 'blueletterbible.org') return;
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
    const before = normalizeSelectionText(beforeRange.toString());
    const selected = normalizeSelectionText(range.toString());
    const after = normalizeSelectionText(afterRange.toString());
    return { text: before + selected + after, start: before.length, end: before.length + selected.length };
  } catch (_) { return null; }
}

function resolveBibleReferenceFromContextWindow(text, selectionStart, selectionEnd) {
  const source = normalizeSelectionText(text);
  if (!source) return null;
  // Handle same-book comma continuations by the exact selected token.
  //   Psalms 1:2, 105:1  -> selecting 105 means Psalm 105:1
  //   Psalms 1:2, 105     -> selecting 105 means Psalm 1:105, then the
  //                            normal boundary rule clamps it to Psalm 1:6.
  // Full book names resolve directly through BOOKS; short forms still use
  // BOOK_ALIASES through resolveBibleBook().
  const commaContinuationRe = /((?:[1-3]\s*|i{1,3}\s*)?[A-Za-z][A-Za-z.'-]{1,24}(?:\s+[A-Za-z][A-Za-z.'-]{1,24}){0,3})\s+(\d+)\s*:\s*(\d+)\s*,\s*(\d+)(?:\s*:\s*(\d+))?/gi;
  let commaMatch;
  while ((commaMatch = commaContinuationRe.exec(source))) {
    const book = resolveBibleBook(commaMatch[1]);
    if (!book) continue;
    const secondNumberStart = commaMatch.index + commaMatch[0].lastIndexOf(commaMatch[4]);
    const secondNumberEnd = secondNumberStart + commaMatch[4].length;
    if (selectionStart < secondNumberStart || selectionEnd > secondNumberEnd) continue;
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
      url: `https://www.blueletterbible.org/kjv/${urlKey}/1/1/`
    };
  } catch (_) {
    return null;
  }
}

function getDoubleClickBlockContextReference(selectionText, target, event = null) {
  try {
    let selected = normalizeSelectionText(selectionText);
    const initialNode = target instanceof Element ? target : (target?.parentElement || null);

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
        const candidateText = normalizeSelectionText(candidate.textContent || '');
        if (candidateText && !/\\s/.test(candidateText)) {
          selected = candidateText;
          break;
        }
      }
    }
    if (!selected) return null;
    const node = initialNode || document.documentElement;

    // Start with the smallest semantic block, but climb through its semantic
    // ancestors when that block contains only the numeric token (or otherwise
    // cannot establish the selected reference). This fixes cases such as
    // "Matthew 18 ... Luke 17" where the clicked 18 lives in a nested span/div
    // and the immediate block loses the nearby book name. The climb remains
    // positional and stops at the nearest ancestor that contains the selected
    // token inside an actual parsed reference, so unrelated paragraph-wide
    // references cannot leak into the gesture.
    const blockCandidates = [];
    let candidateNode = node;
    while (candidateNode && candidateNode !== document.documentElement?.parentElement) {
      if (candidateNode instanceof Element && candidateNode.matches('p,li,td,th,blockquote,article,section,div')) {
        blockCandidates.push(candidateNode);
      }
      candidateNode = candidateNode.parentElement;
    }
    if (!blockCandidates.length && node instanceof Element) blockCandidates.push(node);

    let block = null;
    for (const candidate of blockCandidates) {
      const candidateRaw = String(candidate.textContent || '');
      const candidateSource = normalizeSelectionText(candidateRaw);
      if (!candidateSource) continue;
      const candidateRefs = resolveBibleReferenceText(candidateSource);
      if (!candidateRefs.length) continue;

      let start = null;
      let end = null;
      try {
        const contextualTarget = getDoubleClickTargetElement(event) || initialNode;
        if (contextualTarget && candidate.contains(contextualTarget)) {
          const targetRange = document.createRange();
          targetRange.selectNodeContents(contextualTarget);
          const scratch = document.createRange();
          scratch.selectNodeContents(candidate);
          scratch.setEnd(targetRange.startContainer, targetRange.startOffset);
          start = normalizeSelectionText(scratch.toString()).length;
          scratch.setEnd(targetRange.endContainer, targetRange.endOffset);
          end = normalizeSelectionText(scratch.toString()).length;
        }
      } catch (_) {}

      if (start == null || end == null || end <= start) {
        const tokenIndex = candidateSource.indexOf(selected);
        if (tokenIndex >= 0) { start = tokenIndex; end = tokenIndex + selected.length; }
      }

      if (start != null && end != null) {
        const containsReference = candidateRefs.some(ref => {
          const refText = normalizeSelectionText(ref.text || '');
          if (!refText) return false;
          let from = candidateSource.indexOf(refText);
          while (from >= 0) {
            const to = from + refText.length;
            if (start < to && end > from) return true;
            from = candidateSource.indexOf(refText, from + 1);
          }
          return false;
        });
        if (containsReference) { block = candidate; break; }
      }
    }

    // Preserve the old nearest-block fallback for non-reference selections.
    if (!block) block = node?.closest?.('p,li,td,th,blockquote,article,section,div') || node;
    if (!block) return null;

    const rawSource = String(block.textContent || '');
    const source = normalizeSelectionText(rawSource);
    if (!source) return null;
    const refs = resolveBibleReferenceText(source);
    if (!refs.length) return null;

    // Context is positional: the selected browser range must be inside the
    // exact occurrence of the parsed reference. Sharing a paragraph is not
    // enough, so an orphan 16/36 cannot borrow an earlier reference.
    const sel = window.getSelection?.();
    const selectedRange = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;

    const getOffset = (container, offset) => {
      const scratch = document.createRange();
      scratch.selectNodeContents(block);
      scratch.setEnd(container, offset);
      return scratch.toString().length;
    };
    let selectionStart = null;
    let selectionEnd = null;
    if (selectedRange) {
      const selectedMeaningfulText = normalizeSelectionText(sel.toString());
      if (selectedMeaningfulText) {
        selectionStart = getOffset(selectedRange.startContainer, selectedRange.startOffset);
        selectionEnd = getOffset(selectedRange.endContainer, selectedRange.endOffset);
      }
    }

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
      const targetText = normalizeSelectionText(contextualTarget?.textContent || '');
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
      const value = normalizeSelectionText(needle || '');
      if (!value) return [];
      const escapeRegex = part => part.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
      const parts = value.split(/\s+/).map(escapeRegex);
      if (!parts.length) return [];
      const pattern = new RegExp(parts.join('\\s+'), 'gi');
      const occurrences = [];
      let match;
      while ((match = pattern.exec(rawSource))) {
        occurrences.push({start: match.index, end: match.index + match[0].length});
        if (match[0].length === 0) pattern.lastIndex++;
      }
      return occurrences;
    };

    for (const ref of refs) {
      if (!ref || ref.chapter == null || !ref.text) continue;
      for (const occurrence of findOccurrences(ref.text)) {
        if (selectionStart >= occurrence.start && selectionEnd <= occurrence.end) {
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
    if (!suiteEnabled || isDoubleClickExcludedTarget(event.target)) return;

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

        const contextualTarget=getDoubleClickTargetElement(event)||event.target;
        const blockContext=getDoubleClickBlockContextReference(selection,contextualTarget,event);

        // Numeric tokens are ambiguous: 3/17/etc. are valid standalone book
        // numbers, but inside a nearby Book + Chapter reference they belong to
        // that positional reference. Keep waiting while context is unsettled.
        if (!blockContext && /^\d+$/.test(selection) && Date.now()-started<1500) {
          requestAnimationFrame(dispatch);
          return true;
        }

        const standaloneBook=getStandaloneBookReference(selection);
        const blockText=normalizeSelectionText(
          event?.target?.closest?.('p,li,td,th,blockquote,article,section,div')?.textContent||''
        );
        const isStandaloneNumericBook=standaloneBook && /^\d+$/.test(selection) && blockText===selection;
        const contextualReference=isStandaloneNumericBook ? standaloneBook : (blockContext||standaloneBook);

        if (!contextualReference) {
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
              requestId,
              tabBehavior:{activeIfNew:false,activateExisting:true}
            });
            return true;
          }
          if (Date.now()-started<1500) requestAnimationFrame(dispatch);
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
    const host = String(location.hostname || '').toLowerCase();
    return host.includes('bible');
  }
}

async function refreshDoubleClickBlb() {
  const siteKey = getPageSelectionSiteKey();
  if (siteKey === 'blueletterbible.org' || !suiteEnabled || !siteKey) {
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

function isBlbPageButtonExcludedSite() {
  const host = String(location.hostname || '').toLowerCase();
  return host === 'blueletterbible.org' || host.endsWith('.blueletterbible.org');
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
  const source = normalizeSelectionText(text)
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

function invalidateBlbPageSelectionButton() {
  blbPageButtonSelection = '';
  blbPageButtonContextualReference = null;
  blbPageButtonDirectUrl = null;
  blbPageButtonVisible = false;
  const button = document.getElementById(BLB_PAGE_BUTTON_ID);
  if (button) button.style.display = 'none';
  // Do not expose a stale selection to the context-menu entry.
}

function setBlbPageButtonVisible(visible) {
  blbPageButtonVisible = !!visible;
  const button = document.getElementById(BLB_PAGE_BUTTON_ID);
  if (button) button.style.display = blbPageButtonVisible ? 'block' : 'none';
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
  button.title = 'Open the selected Bible text or references in BLB';
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
    safeRuntimeSendMessage({type:'blbSuiteOpenSelectionText', text, contextualReference: blbPageButtonContextualReference || null, directUrl: blbPageButtonDirectUrl || null});
    setTimeout(() => { pageButtonActionInProgress = false; }, 0);
  });

  mount.appendChild(button);
}

async function updateBlbPageSelectionButtonFromSelection() {
  if (!pageButtonMonitoring || isBlbPageButtonExcludedSite()) return;
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
  setBlbPageButtonVisible(false);
  if (!text || !suiteEnabled) return;

  // The floating control is a UI entry point, not a classifier. Always show
  // it for a non-empty text selection and let the shared background resolver
  // decide what the selection means when the user clicks it. This is important
  // for commentary text, partial references, adjacent references, OCR/PDF text,
  // and selections containing words that are not present in the local KJV index.
  // Previously the button was hidden whenever any of several local/background
  // eligibility checks failed, making the control appear to be broken even
  // though Alt+B/right-click could still resolve the same selection.
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
  if (pageButtonMonitoring || isBlbPageButtonExcludedSite() || !suiteEnabled) return;
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
}

function disableBlbPageButtonMonitoring() {
  pageButtonValidationToken++;
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      sendResponse({ok:true, text:window.getSelection ? window.getSelection().toString() : ''});
    } catch (_) {
      sendResponse({ok:true, text:''});
    }
    return;
  }
});

async function refreshBlbPageSelectionButton() {
  if (isBlbPageButtonExcludedSite()) {
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
  // controls the floating Show on BLB button. Do this proactively rather than
  // waiting for contextMenus.onShown, because an asynchronous visibility
  // update from onShown can take effect only on the second right-click.
  if (suiteEnabled && shouldEnable) {
    // Do not expose the floating button until the native right-click item has
    // finished being synchronized. This removes the small first-click race
    // where the floating button was visible but the context-menu item was not.
    await safeRuntimeSendMessage({type:'blbSuiteSyncSelectionContextMenu'});
  } else {
    await safeRuntimeSendMessage({type:'blbSuiteSyncSelectionContextMenu'});
  }
  if (!suiteEnabled || !shouldEnable) {
    disableBlbPageButtonMonitoring();
    return;
  }
  enableBlbPageButtonMonitoring();
}

if (!isBlbPageButtonExcludedSite()) {
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
      if (location.hostname !== 'blueletterbible.org' && !location.hostname.endsWith('.blueletterbible.org')) {
        refreshBlbPageSelectionButton();
      }
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