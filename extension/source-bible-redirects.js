// URL/reference parsing and page-load redirect decisions for supported Bible sites.
// Click guards and listener registration stay in content.js.
globalThis.BLBSourceBibleRedirectModule = Object.freeze({
  create({ books, shared, locationApi, resolveBibleBook, resolveBibleReference, openBlbDestinationFromContent }) {
    const BOOKS = books;
    const BLBShared = shared;
    const location = locationApi;
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

    return Object.freeze({
      bookKey, decodeSafe, blbUrl, normalizeSourceBibleBook, formatSourceBibleBookName,
      parseRef, validateSourceBibleReference, parseChristianityBibleLink,
      christianityBibleLinkTarget, redirectBibleSite, theKingsBibleLinkTarget, redirectBlbNet
    });
  }
});
