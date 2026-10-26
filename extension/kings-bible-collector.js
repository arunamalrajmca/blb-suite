/*
 * The King's Bible Dictionary/Concordance collector feature module.
 * Shared content-script helpers are injected explicitly by content.js so this
 * feature can be tested and routed independently without duplicating parsers.
 */
globalThis.BLBKingsBibleCollector = Object.freeze({
  initialize({
    BOOKS,
    normalizeSelectionText,
    parseRef,
    resolveBibleReference,
    blbUrl,
    isSuiteEnabled,
    makeBlbMultiVerseButtonDraggable
  }) {
// ---------- The King's Bible Dictionary/Concordance MultiVerse ----------
const kingsBibleEntryPath = location.pathname.replace(/\/{2,}/g, "/");
const kingsBibleEntryMatch = kingsBibleEntryPath.match(/^\/(dictionary|concordance)\/[^/]+(?:\/\d+)?\/?$/i);
if (location.hostname?.toLowerCase().replace(/^www\./, "") === "thekingsbible.com" &&
    kingsBibleEntryMatch) {
  const kingsBibleEntryType = kingsBibleEntryMatch[1].toLowerCase();
  function collectKingsBibleReferences(sourceDocument = document, sourceUrl = location.href) {
    const refs = [];
    const seen = new Set();
    const elements = kingsBibleEntryType === "concordance"
      ? sourceDocument.querySelectorAll('#ConcordanceTable a.concordanceitem[href^="/Bible/"], a.concordanceitem[href^="/Bible/"]')
      : sourceDocument.querySelectorAll(".bible[data-bible], a.bible");

    for (const element of elements) {
      const label = normalizeSelectionText(element.textContent || "");
      let parsed = parseRef(label);
      let bookName = parsed?.book;
      let chapter = parsed?.chapter;
      let from = parsed?.from ?? 1;
      let to = parsed?.to ?? null;
      let usedStructuredReference = false;

      // Concordance entries identify the verse directly in their /Bible/<book>/<chapter>?verse=<n> URL.
      // Use that structured route rather than relying on abbreviated display labels such as "Ex 4:14".
      if (kingsBibleEntryType === "concordance") {
        try {
          const sourceLink = new URL(element.getAttribute("href") || "", sourceUrl);
          const match = sourceLink.pathname.match(/^\/Bible\/(\d+)\/(\d+)\/?$/i);
          if (match) {
            const book = BOOKS.find(item => Number(item.bookNumber) === Number(match[1]));
            const verseParam = sourceLink.searchParams.get("verse");
            const verse = verseParam && /^\d+$/.test(verseParam) ? Number(verseParam) : 1;
            if (book && Number(match[2]) > 0 && verse > 0) {
              bookName = book.name;
              chapter = Number(match[2]);
              from = verse;
              to = null;
              usedStructuredReference = true;
            }
          }
        } catch (_) {}
      }

      // Abbreviated spans (e.g. "9:20" or "17:15-17") use a numeric data-bible ID.
      // Prefer the encoded book/chapter/verse whenever the visible label omits the book.
      const encoded = String(element.getAttribute("data-bible") || "");
      const abbreviatedLabel = /^\d+:\d+(?:-\d+)?$/.test(label);
      if (abbreviatedLabel && /^\d{7,8}$/.test(encoded)) {
        const bookCode = encoded.slice(0, -6);
        chapter = Number(encoded.slice(-6, -3));
        from = Number(encoded.slice(-3));
        const book = bookCode === "65"
          ? BOOKS.find(item => item.name.toLowerCase() === "judges")
          : BOOKS.find(item => Number(item.bookNumber) === Number(bookCode));
        const range = label.match(/^(\d+):(\d+)-(\d+)$/);
        if (!book || chapter < 1 || from < 1) continue;
        bookName = book.name;
        usedStructuredReference = true;
        if (range && Number(range[1]) === chapter && Number(range[2]) === from && Number(range[3]) >= from) {
          to = Number(range[3]);
        } else {
          to = null;
        }
      } else if (!parsed) {
        if (!/^\d{7,8}$/.test(encoded)) continue;
        const bookCode = encoded.slice(0, -6);
        chapter = Number(encoded.slice(-6, -3));
        from = Number(encoded.slice(-3));
        const book = bookCode === "65"
          ? BOOKS.find(item => item.name.toLowerCase() === "judges")
          : BOOKS.find(item => Number(item.bookNumber) === Number(bookCode));
        if (!book || chapter < 1 || from < 1) continue;
        bookName = book.name;
        to = null;
      }

      const resolved = resolveBibleReference(bookName, chapter, from, to);
      if (!resolved) continue;
      const target = blbUrl(resolved.book.name, resolved.chapter, resolved.from, resolved.to);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      refs.push({
        book: resolved.book.name,
        bookNumber: Number(resolved.book.bookNumber),
        chapter: resolved.chapter,
        from: resolved.from,
        to: resolved.to,
        version: "kjv",
        // Structured source data determines the passage; use the caption when parsing it supplied the reference.
        text: usedStructuredReference || !label
          ? `${resolved.book.name} ${resolved.chapter}:${resolved.from}${resolved.to != null && resolved.to !== resolved.from ? "-" + resolved.to : ""}`
          : label,
        url: target
      });
    }
    return refs;
  }

  async function collectAllKingsBibleReferences() {
    // Only Concordance entries use multi-page collection; Dictionary entries stay on the current page.
    if (kingsBibleEntryType !== "concordance") {
      return collectKingsBibleReferences(document, location.href);
    }
    const refs = [];
    const seen = new Set();
    const pending = [location.href];
    const queued = new Set(pending);
    const visited = new Set();
    const currentUrl = new URL(location.href);
    const pathParts = currentUrl.pathname.replace(/\/$/, "").split("/");
    // Concordance pagination commonly uses /Concordance/term/1, /2, etc.
    if (/^\d+$/.test(pathParts[pathParts.length - 1] || "")) pathParts.pop();
    const basePath = pathParts.join("/") || "/";
    // Pagination anchors may all use href="#", so read the numbered controls
    // to learn the actual page count before probing numbered Concordance routes.
    const pageNumbers = [...document.querySelectorAll("ul.pagination li.current-page a")]
      .map(anchor => Number(normalizeSelectionText(anchor.textContent || "")))
      .filter(pageNumber => Number.isInteger(pageNumber) && pageNumber > 0);
    const lastPage = pageNumbers.length ? Math.max(...pageNumbers) : 1;
    // Keep a conservative fallback for markup without numbered pagination controls.
    const pageCount = pageNumbers.length ? Math.min(lastPage, 20) : 10;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const pageUrl = new URL(basePath.replace(/\/$/, "") + "/" + pageNumber, currentUrl.origin).href;
      if (!queued.has(pageUrl)) {
        pending.push(pageUrl);
        queued.add(pageUrl);
      }
    }
    const isEntryPage = url => {
      if (url.origin !== location.origin) return false;
      const path = url.pathname.replace(/\/$/, "");
      return path === basePath || (path.startsWith(basePath + "/") && /^\d+$/.test(path.slice(basePath.length + 1)));
    };
    while (pending.length && visited.size < 20) {
      const pageUrl = pending.shift();
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);
      let pageDocument = document;
      if (pageUrl !== location.href) {
        try {
          const response = await fetch(pageUrl, { credentials: "same-origin" });
          if (!response.ok) continue;
          pageDocument = new DOMParser().parseFromString(await response.text(), "text/html");
        } catch (_) { continue; }
      }
      for (const ref of collectKingsBibleReferences(pageDocument, pageUrl)) {
        if (seen.has(ref.url)) continue;
        seen.add(ref.url);
        refs.push(ref);
      }
      const sourcePageUrl = new URL(pageUrl);
      const normalizedPath = value => value.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
      const paginationParam = /^(?:page|p|pageindex|pagenumber|pageno|currentpage|page_num|page-number|page_no|pg|offset|skip)$/i;
      for (const anchor of pageDocument.querySelectorAll("a[href]")) {
        try {
          const url = new URL(anchor.getAttribute("href"), pageUrl);
          if (!isEntryPage(url)) continue;
          const label = normalizeSelectionText(anchor.textContent || "");
          const accessibleLabel = normalizeSelectionText([
            anchor.getAttribute("aria-label"),
            anchor.getAttribute("title"),
            anchor.getAttribute("rel")
          ].filter(Boolean).join(" "));
          const currentPath = normalizedPath(sourcePageUrl);
          const targetPath = normalizedPath(url);
          const pathChanged = targetPath !== currentPath;
          const changedPaginationParam = [...url.searchParams.keys()].some(key =>
            paginationParam.test(key) &&
            url.searchParams.get(key) !== sourcePageUrl.searchParams.get(key)
          );
          const paginationLabel = /^(?:next|last|first|previous|prev|\d+|[‹›«»<>]+)$/i.test(label) ||
            /\b(?:next|last|first|previous|prev)\b/i.test(accessibleLabel);
          // Pagination may use a trailing numeric path segment or a query parameter
          // (including pageNumber/pageNo); don't depend on the visible link text alone.
          const changedQuery = url.search !== sourcePageUrl.search;
          // Some pagination controls use site-specific query parameter names.
          // When the link is visibly a page/next/previous control, accept its
          // changed query string even if the parameter name is unfamiliar.
          const isPageLink = pathChanged || changedPaginationParam ||
            (paginationLabel && changedQuery);
          if (!isPageLink) continue;
          url.hash = "";
          if (!visited.has(url.href) && !queued.has(url.href)) {
            pending.push(url.href);
            queued.add(url.href);
          }
        } catch (_) {}
      }
    }
    return refs;
  }

  function showKingsBibleStatus(message, isError = false) {
    let box = document.getElementById("blb-suite-kingsbible-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "blb-suite-kingsbible-status";
      box.style.cssText = "position:fixed;right:18px;bottom:72px;z-index:2147483647;background:#fff;border:1px solid #bbb;border-radius:6px;padding:9px 12px;font:13px Arial,sans-serif;color:#222;box-shadow:0 2px 10px rgba(0,0,0,.18)";
      (document.body || document.documentElement)?.appendChild(box);
    }
    if (!box) return;
    box.textContent = message;
    box.style.color = isError ? "#b00020" : "#222";
    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.remove(), 3500);
  }

  async function openAllKingsBibleRefs() {
    showKingsBibleStatus("Collecting references across pages…");
    const refs = await collectAllKingsBibleReferences();
    if (!refs.length) {
      showKingsBibleStatus("No Bible references found across the entry pages.", true);
      return;
    }
    if (refs.length === 1) {
      chrome.runtime.sendMessage({
        type: "blbSuiteOpenBackgroundUrl",
        url: refs[0].url,
        activeIfNew: true,
        activateExisting: true
      }).catch(() => {});
      return;
    }
    chrome.runtime.sendMessage({type: "blbSuiteOpenWebsterMultiVerse", refs}).then(response => {
      if (!response?.ok) {
        showKingsBibleStatus("Unable to open BLB MultiVerse.", true);
        return;
      }
      showKingsBibleStatus(`Opening ${refs.length} Bible references in BLB MultiVerse…`);
    }).catch(() => showKingsBibleStatus("Unable to open BLB MultiVerse.", true));
  }

  async function ensureKingsBibleButton() {
    if (!(await isSuiteEnabled()) || !document.body ||
        document.getElementById("blb-suite-kingsbible-multiverse")) return;
    const button = document.createElement("button");
    button.id = "blb-suite-kingsbible-multiverse";
    button.type = "button";
    button.textContent = "Open Bible References in BLB";
    button.title = `Collect all Bible references on this ${kingsBibleEntryType === "concordance" ? "Concordance" : "Dictionary"} page and open them together in BLB MultiVerse.`;
    button.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#292a2d;color:#f1f3f4;border:1px solid #505257;border-radius:7px;padding:9px 12px;font:600 13px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.42)";
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openAllKingsBibleRefs();
    });
    document.body.appendChild(button);
    makeBlbMultiVerseButtonDraggable(button);
  }

  const ensureKingsBibleButtonWhenReady = () => ensureKingsBibleButton().catch(() => {});
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureKingsBibleButtonWhenReady, {once: true});
  } else {
    ensureKingsBibleButtonWhenReady();
  }
  setTimeout(ensureKingsBibleButtonWhenReady, 500);
  setTimeout(ensureKingsBibleButtonWhenReady, 1500);

  chrome.storage.onChanged.addListener(changes => {
    if (changes.masterEnabled?.newValue === false) {
      document.getElementById("blb-suite-kingsbible-multiverse")?.remove();
      document.getElementById("blb-suite-kingsbible-multiverse-reset-position")?.remove();
      document.getElementById("blb-suite-kingsbible-status")?.remove();
    } else if (changes.masterEnabled?.newValue === true) {
      ensureKingsBibleButtonWhenReady();
    }
  });
}
  }
});
