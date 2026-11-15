// Owns dynamic BLB parsing-popup links and canonical destination opening.
(function (global) {
  function initialize({
    BLB_HOSTNAME,
    BLBShared,
    isSuiteEnabledNow,
    isModifiedLinkActivation,
    openBlbDestinationFromContent
  }) {
    global.__blbParsePopupCleanup?.();
    if (
      !location.hostname.endsWith(BLB_HOSTNAME) ||
      /(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)
    ) return;

    const listenerController = new AbortController();
    const boundLinks = new Set();
    let parsePopupObserver = null;
    global.__blbParsePopupCleanup = () => {
      parsePopupObserver?.disconnect(); listenerController.abort();
      for (const link of boundLinks) delete link.dataset.blbSuitePopup;
      boundLinks.clear();
    };
    const handleParsePopupLink = link => {
      if (!link || !link.href || !link.closest?.(".parse-popup")) return;
      if (link.dataset.blbSuitePopup) return;
      link.dataset.blbSuitePopup = "1";
      boundLinks.add(link);
      link.addEventListener("click", event => {
        if (!isSuiteEnabledNow() || isModifiedLinkActivation(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();

        openBlbDestinationFromContent(link.href);

        const match = link.href.match(/lexicon\/(g|h)\d+/i);
        if (match) {
          const criteriaUrl =
            `${BLBShared.urls.blbSearch}?Criteria=${match[0].split("/").pop()}`;
          openBlbDestinationFromContent(criteriaUrl);
        }
      }, { capture: true, signal: listenerController.signal });
    };

    const processParsePopups = (root = document) => {
      if (!isSuiteEnabledNow()) return;
      // MutationObserver may report the anchor itself when BLB appends a new
      // link directly into an existing popup. querySelectorAll() excludes the
      // root node, so process matching root anchors explicitly as well.
      if (root.matches?.("a[href]")) handleParsePopupLink(root);
      root.querySelectorAll?.(".parse-popup a[href]").forEach(handleParsePopupLink);
    };

    parsePopupObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) processParsePopups(node);
        }
      }
    });
    parsePopupObserver.observe(document.documentElement, { childList: true, subtree: true });
    processParsePopups();
    return Object.freeze({ refresh() { processParsePopups(); } });
  }

  global.BLBParsePopupModule = { initialize };
})(globalThis);
