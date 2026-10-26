// Source-specific click routing for Christianity resources and The King's Bible.
// This module owns only click redirection; general host redirects remain in content.js.
globalThis.BLBSourceSiteClickRedirectsModule = Object.freeze({
  initialize({ windowApi, documentApi, locationApi, chromeApi, books, resolveBibleReference, blbUrl, christianityBibleLinkTarget, parseRef, theKingsBibleLinkTarget, openBlbDestinationFromContent, isModifiedLinkActivation, isSuiteEnabled, getCachedSuiteEnabled, isSourceRedirectEnabled }) {
    const window = windowApi;
    const document = documentApi;
    const location = locationApi;
    const chrome = chromeApi;
    const BOOKS = books;
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


// On The King's Bible Dictionary/Concordance pages, keep the source page open.
// Only clicked Bible-passage and Strong's links are sent to BLB in a new tab.
let theKingsBibleRedirectEnabled = false;
if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get({redirectEnabled:false}).then(data => {
    theKingsBibleRedirectEnabled = data.redirectEnabled === true;
  }).catch(() => {});
}


if (location.hostname?.toLowerCase().replace(/^www\./, "") === "thekingsbible.com" &&
    /^\/(?:dictionary|concordance)\//i.test(location.pathname.replace(/\/{2,}/g, "/"))) {
  document.addEventListener("click", event => {
    if (event.defaultPrevented || isModifiedLinkActivation(event)) return;
    if (!theKingsBibleRedirectEnabled || !getCachedSuiteEnabled()) return;

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



  }
});
