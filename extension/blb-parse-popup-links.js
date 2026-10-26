// BLB parsing-popup link handling and stable tab reuse.
globalThis.BLBParsePopupLinksModule = Object.freeze({
  initialize({ getCachedEnabled, isModifiedLinkActivation, openBlbDestinationFromContent, blbHostname, blbSearchUrl }) {
    if (!location.hostname.endsWith(blbHostname)) return;
    // Keep parsing-popup links working on both normal BLB verse pages and
    // Criteria Search pages. A stable window name prevents repeated clicks from
    // opening duplicate tabs; the same tab is reused for the same destination.
    if (location.hostname.endsWith(blbHostname)) {
      const handleParsePopupLink = link => {
        if (!link || !link.href || !link.closest?.(".parse-popup")) return;
        if (link.dataset.blbSuitePopup) return;
        link.dataset.blbSuitePopup = "1";
        link.addEventListener("click", e => {
          if (!getCachedEnabled() || isModifiedLinkActivation(e)) return;
          e.preventDefault();
          e.stopImmediatePropagation();
    
          openBlbDestinationFromContent(link.href);
    
          const m = link.href.match(/lexicon\/(g|h)\d+/i);
          if (m) {
            const criteriaUrl =
              `${blbSearchUrl}?Criteria=${m[0].split("/").pop()}`;
            openBlbDestinationFromContent(criteriaUrl);
          }
        }, true);
      };
    
      const processParsePopups = (root = document) => {
        if (!getCachedEnabled()) return;
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
      parsePopupObserver.observe(document.documentElement, {childList:true, subtree:true});
      processParsePopups();
    }
  }
});
