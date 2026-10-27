// Owns BLB verse-link target behavior and ordinary nowrap-link navigation.
(function (global) {
  function initialize({
    BLB_HOSTNAME,
    isSuiteEnabledNow,
    isModifiedLinkActivation,
    openBlbDestinationFromContent
  }) {
    if (
      !location.hostname.endsWith(BLB_HOSTNAME) ||
      /(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)
    ) return;

    function modifyLinks(container) {
      container.querySelectorAll("a").forEach(link => {
        if (!link.href) return;
        if (link.closest(".parse-popup")) {
          // Parsing-popup links have their own handler and tab-reuse behavior.
        } else if (link.closest('div[id^="bVerse_"]')) {
          link.target = "_blank";
        }
      });
    }

    const process = (root = document) => {
      if (!isSuiteEnabledNow()) return;
      if (root.matches?.('div[id^="bVerse_"], .parse-popup')) modifyLinks(root);
      root.querySelectorAll?.('div[id^="bVerse_"], .parse-popup').forEach(modifyLinks);
    };

    let processScheduled = false;
    const pendingRoots = [];
    const scheduleProcess = (root = null) => {
      if (root) pendingRoots.push(root);
      if (processScheduled) return;
      processScheduled = true;
      requestAnimationFrame(() => {
        processScheduled = false;
        if (!isSuiteEnabledNow()) { pendingRoots.length = 0; return; }
        if (!pendingRoots.length) { process(); return; }
        const roots = pendingRoots.splice(0, pendingRoots.length);
        const seen = new Set();
        for (const root of roots) {
          if (!root || seen.has(root) || !root.isConnected) continue;
          seen.add(root);
          process(root);
        }
      });
    };

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) scheduleProcess(node);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("click", event => {
      if (!isSuiteEnabledNow() || isModifiedLinkActivation(event)) return;
      const link = event.target.closest?.("a.nowrap");
      if (!link) return;
      // Criteria Search owns ordinary KJV verse links on its results page.
      if (
        location.pathname.toLowerCase() === "/search/search.cfm" &&
        /\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href)
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openBlbDestinationFromContent(link.href);
    }, true);

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", process);
    else process();
  }

  global.BLBVerseLinkNavigationModule = { initialize };
})(globalThis);
