// MAIN-world click guard for supported Bible-reference source sites. This script deliberately does
// not resolve Bible references or call extension APIs; it asks the isolated
// content script to handle a candidate passage and cancels native navigation
// only when that script confirms a valid BLB destination.
(() => {
  if (window.__blbSourcePassageClickGuardInstalled) return;
  window.__blbChristianityClickGuardInstalled = true;

  window.addEventListener("click", event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return;

    const node = event.target instanceof Element
      ? event.target
      : event.target && event.target.parentElement;
    const anchor = node && node.closest ? node.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download")) return;

    let url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return; }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["christianity.com", "gotquestions.org", "crosswalk.com", "enduringword.com"].includes(host)) return;
    const label = String(anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim();
    const isChristianityPassage = host === "christianity.com" &&
      /^\/bible\/[^/]+\/[^/]+\/\d+(?:-\d+(?:-\d+)?)?\/?$/i.test(url.pathname);
    const isReferenceLabel = /^(?:[1-3]\s*)?[A-Za-z][A-Za-z .'-]*\s+\d+(?::\d+(?:[-–]\d+)?|\s+\d+(?:[-–]\d+)?)?(?:\s*\((?:KJV|NKJV|ESV|NIV|NASB|CSB|NLT|WEB|AMP|RSV|ASV)\))?$/i.test(label);
    if (!isChristianityPassage && !isReferenceLabel) return;
    const request = new CustomEvent("blb-suite-source-passage-click", {
      detail: JSON.stringify({ href:url.href, label }),
      cancelable: true
    });
    const handled = !window.dispatchEvent(request);
    if (!handled) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }, true);
})();