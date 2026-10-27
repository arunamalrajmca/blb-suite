// Owns dynamic BLB parsing-popup links and canonical destination opening.
(function (global) {
  function initialize({
    BLB_HOSTNAME,
    BLBShared,
    isSuiteEnabledNow,
    isModifiedLinkActivation,
    openBlbDestinationFromContent
  }) {
    if (
      !location.hostname.endsWith(BLB_HOSTNAME) ||
      /(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname)
    ) return;

    const handleParsePopupLink = link => {
      if (!link || !link.href || !link.closest?.(".parse-popup")) return;
      if (link.dataset.blbSuitePopup) return;
      link.dataset.blbSuitePopup = "1";
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
      }, true);
    };

    const processParsePopups = (root = document) => {
      if (!isSuiteEnabledNow()) return;
      if (root.matches?.(".parse-popup")) handleParsePopupLink(root);
      root.querySelectorAll?.(".parse-popup a[href]").forEach(handleParsePopupLink);
    };

    const parsePopupObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) processParsePopups(node);
        }
      }
    });
    parsePopupObserver.observe(document.documentElement, { childList: true, subtree: true });
    processParsePopups();
  }

  global.BLBParsePopupModule = { initialize };
})(globalThis);
