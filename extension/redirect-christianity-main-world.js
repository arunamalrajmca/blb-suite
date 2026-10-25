// MAIN-world click guard for Christianity.com. This script deliberately does
// not resolve Bible references or call extension APIs; it asks the isolated
// content script to handle a candidate passage and cancels native navigation
// only when that script confirms a valid BLB destination.
(() => {
  if (window.__blbChristianityClickGuardInstalled) return;
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
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "christianity.com") return;

    // Only passage routes are candidates. Unknown books/references are still
    // allowed to use Christianity.com's normal navigation because the
    // isolated-world resolver must explicitly cancel this event to claim it.
    if (!/^\/bible\/[^/]+\/[^/]+\/\d+(?:-\d+(?:-\d+)?)?\/?$/i.test(url.pathname)) return;

    const request = new CustomEvent("blb-suite-christianity-passage-click", {
      detail: { href: url.href },
      cancelable: true
    });
    const handled = !window.dispatchEvent(request);
    if (!handled) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }, true);
})();