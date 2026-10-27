/* Source-page Bible reference collection for supported commentary/reference sites. */
globalThis.BLBSourcePageCollectorModule = Object.freeze({
  initialize({ normalizeSelectionText, parseRef, normalizeSourceBibleBook, resolveBibleReference, blbUrl, formatSourceBibleBookName, isSuiteEnabled, makeBlbMultiVerseButtonDraggable }) {
    // ---------- Christianity.com, GotQuestions.org, Crosswalk.com, and EnduringWord.com MultiVerse collection ----------
    {
      const host = location.hostname.toLowerCase().replace(/^www\./, "");
      const sourceSite = ({
        "christianity.com":"christianity",
        "gotquestions.org":"gotquestions",
        "crosswalk.com":"crosswalk",
        "enduringword.com":"enduringword",
        "rediscover.bible":"rediscover",
        "sagacityweb.com":"sagacity",
        "thetreasuryofscriptureknowledge.com":"treasury"
      })[host] || "";
      // These sites' homepages are general landing pages, not article/reference
      // pages. Keep the page-wide collection button limited to nested pages.
      const isSourceHomepage = location.pathname === "/" || location.pathname === "";
      if (sourceSite && !isSourceHomepage) {
        const buttonId = "blb-suite-" + sourceSite + "-multiverse";
        const statusId = "blb-suite-" + sourceSite + "-multiverse-status";
    
        function collectSourcePageBibleReferences() {
          const refs = [];
          const seen = new Set();
          // Enduring Word must use only its two structured cross-reference sections.
          // Require chapter-page URLs too, so individual verse links can never enter.
          const enduringSectionAnchors = sourceSite === "enduringword"
            ? Array.from(document.querySelectorAll("aside.ew-xref .ew-xref-sec"))
                .filter(section => /^(?:Related Commentary|Referenced By)\b/i.test(
                  normalizeSelectionText(section.querySelector(".ew-xref-title")?.textContent || "")
                ))
                .flatMap(section => Array.from(section.querySelectorAll(".ew-xref-chips a[href]")))
            : null;
          const anchors = sourceSite === "enduringword"
            ? enduringSectionAnchors
            : Array.from(document.querySelectorAll("a[href]"));
          for (const anchor of anchors) {
            if (anchor.id === buttonId || anchor.closest("#" + buttonId) ||
                anchor.hasAttribute("download")) continue;
            const label = normalizeSelectionText(anchor.innerText || anchor.textContent || "");
            const dataReference = sourceSite !== "enduringword"
              ? anchor.getAttribute("data-bible-ref-link")
              : null;
            // Keep Sagacity's URL-derived citation as a fallback candidate only.
            // Parsing the URL first can override valid captions and regress the
            // previously working page-wide collection.
            let sagacityCriteriaReference = null;
            if (sourceSite === "sagacity") {
              try {
                const targetUrl = new URL(anchor.href, location.href);
                const targetHost = targetUrl.hostname.toLowerCase().replace(/^www\./, "");
                if (targetHost === "blueletterbible.org" &&
                    /^\/search\/preSearch\.cfm$/i.test(targetUrl.pathname)) {
                  const criteria = normalizeSelectionText(
                    String(targetUrl.searchParams.get("Criteria") || "").replace(/\+/g, " ")
                  );
                  // BLB's Sagacity links use dotted chapter/verse notation
                  // (e.g. "Matt. 12.37"). Parse that URL citation independently
                  // of the anchor caption, and canonicalize its book immediately
                  // so abbreviated source names cannot be lost in fallback logic.
                  const criteriaReference = parseRef(criteria.replace(
                    /^(.*?)\s+(\d+)\.(\d+(?:-\d+)?)$/,
                    "$1 $2:$3"
                  ));
                  if (criteriaReference) {
                    criteriaReference.book = normalizeSourceBibleBook(criteriaReference.book);
                  }
                  sagacityCriteriaReference = criteriaReference;
                }
              } catch (_) {}
            }
            // Structured metadata or a BLB URL citation can qualify anchors with
            // empty captions caused by malformed/nested HTML.
            if ((!label || label.length > 100) && !dataReference && !sagacityCriteriaReference) continue;
            let parsed;
            if (sourceSite === "enduringword") {
              let url;
              try { url = new URL(anchor.href, location.href); } catch (_) { continue; }
              const chapterPath = url.hostname.toLowerCase().replace(/^www\./, "") === "enduringword.com"
                ? url.pathname.match(/^\/bible-commentary\/([^/]+?)-(\d+)\/?$/i)
                : null;
              // Only chapter commentary URLs qualify; ignore verse URLs and body references.
              if (!chapterPath) continue;
              parsed = { book: chapterPath[1].replace(/-/g, " "), chapter: Number(chapterPath[2]), from: 1, to: null };
            } else {
              // Prefer structured Bible-reference metadata when a site's visible
              // caption is abbreviated (e.g. "3:11") or otherwise not a full
              // reference. Ignore the source translation; BLB resolves to KJV.
              if (!parsed && dataReference) {
                const rawReference = dataReference.split("|", 1)[0]
                  .replace(/_/g, " ")
                  .replace(/[–—]/g, "-")
                  .trim();
                parsed = parseRef(rawReference);
              }
              // Preserve caption-based collection. Use BLB Criteria only when the
              // caption and structured metadata do not provide a usable reference.
              if (!parsed) parsed = parseRef(label);
              if (!parsed) parsed = sagacityCriteriaReference;
            }
            let usedStructuredReference = sourceSite !== "enduringword" && Boolean(dataReference) && Boolean(parsed);
            if ((!parsed || !parsed.book || !Number.isInteger(Number(parsed.chapter)) ||
                 Number(parsed.chapter) < 1) && usedStructuredReference) {
              // Even malformed structured values should not suppress a valid caption.
              parsed = parseRef(label);
              usedStructuredReference = false;
            }
            if (!parsed || !parsed.book || !Number.isInteger(Number(parsed.chapter)) ||
                Number(parsed.chapter) < 1) continue;
            // Enduring Word chips identify chapters, not individual verses.
            let book = normalizeSourceBibleBook(parsed.book);
            let chapter = Number(parsed.chapter);
            let from = sourceSite === "enduringword" ? 1 : Number(parsed.from);
            let to = sourceSite === "enduringword" ? null : (parsed.to == null ? null : Number(parsed.to));
            if (!Number.isInteger(from) || from < 1) continue;
            let resolved = resolveBibleReference(book, chapter, from, to);
            // Metadata can be syntactically parseable yet refer to an unknown book
            // or an impossible verse. In that case, try the visible caption before
            // discarding a link that still contains a valid full Bible reference.
            if (!resolved && usedStructuredReference) {
              const captionRef = parseRef(label);
              if (captionRef) {
                book = normalizeSourceBibleBook(captionRef.book);
                chapter = Number(captionRef.chapter);
                from = Number(captionRef.from);
                to = captionRef.to == null ? null : Number(captionRef.to);
                if (Number.isInteger(from) && from >= 1) {
                  resolved = resolveBibleReference(book, chapter, from, to);
                  if (resolved) usedStructuredReference = false;
                }
              }
            }
            // A malformed caption may parse but fail actual book/verse resolution.
            // Retry the BLB Criteria citation before discarding that link.
            if (!resolved && sourceSite === "sagacity" && sagacityCriteriaReference) {
              book = normalizeSourceBibleBook(sagacityCriteriaReference.book);
              chapter = Number(sagacityCriteriaReference.chapter);
              from = Number(sagacityCriteriaReference.from);
              to = sagacityCriteriaReference.to == null ? null : Number(sagacityCriteriaReference.to);
              if (Number.isInteger(from) && from >= 1) {
                resolved = resolveBibleReference(book, chapter, from, to);
              }
            }
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
              text: sourceSite === "enduringword"
                ? (formatSourceBibleBookName(resolved.book.name) + " " + resolved.chapter + ":1")
                : (dataReference
                    ? `${formatSourceBibleBookName(resolved.book.name)} ${resolved.chapter}:${resolved.from}${resolved.to != null && resolved.to !== resolved.from ? "-" + resolved.to : ""}`
                    : label),
              url: target
            });
          }
          return refs;
        }
    
        function showSourcePageMultiVerseStatus(message, isError = false) {
          let box = document.getElementById(statusId);
          if (!box) {
            box = document.createElement("div");
            box.id = statusId;
            box.style.cssText = "position:fixed;right:18px;bottom:72px;z-index:2147483647;background:#fff;border:1px solid #bbb;border-radius:6px;padding:9px 12px;font:13px Arial,sans-serif;color:#222;box-shadow:0 2px 10px rgba(0,0,0,.18)";
            (document.body || document.documentElement)?.appendChild(box);
          }
          if (!box) return;
          box.textContent = message;
          box.style.color = isError ? "#b00020" : "#222";
          clearTimeout(box._timer);
          box._timer = setTimeout(() => box.remove(), 3500);
        }
    
        async function openSourcePageBibleReferencesInMultiVerse() {
          const refs = collectSourcePageBibleReferences();
          if (!refs.length) {
            showSourcePageMultiVerseStatus("No linked Bible references found on this page.", true);
            return;
          }
          try {
            const response = await chrome.runtime.sendMessage({
              type: "blbSuiteOpenWebsterMultiVerse",
              refs
            });
            if (!response?.ok) {
              showSourcePageMultiVerseStatus("Unable to open BLB MultiVerse.", true);
              return;
            }
            showSourcePageMultiVerseStatus(`Opening ${refs.length} Bible references in BLB MultiVerse…`);
          } catch (_) {
            showSourcePageMultiVerseStatus("Unable to open BLB MultiVerse.", true);
          }
        }
    
        async function ensureSourcePageMultiVerseButton() {
          if (!(await isSuiteEnabled()) || !document.body || document.getElementById(buttonId)) return;
          const button = document.createElement("button");
          button.id = buttonId;
          button.type = "button";
          button.textContent = "Open Bible References in BLB";
          button.title = "Collect all linked Bible references on this page and open them together in BLB MultiVerse.";
          button.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#292a2d;color:#f1f3f4;border:1px solid #505257;border-radius:7px;padding:9px 12px;font:600 13px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.42)";
          button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            openSourcePageBibleReferencesInMultiVerse();
          });
          document.body.appendChild(button);
          makeBlbMultiVerseButtonDraggable(button);
        }
    
        const ensureSourcePageButtonWhenReady = () => ensureSourcePageMultiVerseButton().catch(() => {});
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", ensureSourcePageButtonWhenReady, {once:true});
        } else {
          ensureSourcePageButtonWhenReady();
        }
        setTimeout(ensureSourcePageButtonWhenReady, 500);
        setTimeout(ensureSourcePageButtonWhenReady, 1500);
    
        chrome.storage.onChanged.addListener(changes => {
          if (changes.masterEnabled?.newValue === false) {
            document.getElementById(buttonId)?.remove();
            document.getElementById(buttonId + "-reset-position")?.remove();
            document.getElementById(statusId)?.remove();
          } else if (changes.masterEnabled?.newValue === true) {
            ensureSourcePageButtonWhenReady();
          }
        });
      }
    }
    
    
  }
});
