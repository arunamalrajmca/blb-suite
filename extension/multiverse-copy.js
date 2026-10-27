// BLB MultiVerse copy enhancement feature module.
// Loaded before content.js; initialized after shared dependencies are defined.
(function (root) {
  function initialize({ BLBShared, resolveBibleBook, isSuiteEnabled }) {
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
        if (!isSuiteEnabled()) return;
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
    
      }
  root.BLBMultiVerseCopyModule = Object.freeze({ initialize });
})(globalThis);
