// BLB MultiVerse and Criteria Search navigation ownership.
globalThis.BLBNavigationLinksModule = Object.freeze({
  initialize({ getCachedEnabled, isModifiedLinkActivation, safeRuntimeSendMessage, openBlbDestinationFromContent, blbHostname, blbSearchUrl }) {
    // ---------- BLB MultiVerse Tool View ----------
    // MultiVerse is intentionally outside the normal BLB New Tab exclusion block.
    // Own KJV verse navigation here so native _blank handling cannot create duplicates.
    if (
      location.hostname.endsWith(blbHostname) &&
      /\/tools\/MultiVerse\.cfm$/i.test(location.pathname)
    ) {
      document.addEventListener("click", e => {
        if (!getCachedEnabled() || isModifiedLinkActivation(e)) return;
        const link = e.target.closest?.('a[href*="/kjv/"]');
        if (!link || !link.href) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void safeRuntimeSendMessage({
          type: 'blbSuiteOpenMultiVerseVerse',
          url: link.href
        });
      }, true);
    }
    
    // ---------- BLB Criteria Search parsing-popup bridge ----------
    // Criteria Search is excluded from the normal BLB New Tab block above because
    // its page has its own navigation handlers. Handle only its parsing-popup
    // links here, using the same stable popup naming as normal BLB verse pages.
    // Do not intercept ordinary Criteria Search links.
    if (
      location.hostname.endsWith(blbHostname) &&
      location.pathname.toLowerCase() === "/search/search.cfm"
    ) {
      document.addEventListener("click", e => {
        if (!getCachedEnabled() || isModifiedLinkActivation(e)) return;
    
        const link = e.target.closest?.(".parse-popup a[href], a.parse-popup[href]");
        if (!link) return;
    
        e.preventDefault();
        e.stopImmediatePropagation();
    
        openBlbDestinationFromContent(link.href);
    
        const lowerHref = link.href.toLowerCase();
        const lexiconIndex = lowerHref.indexOf("/lexicon/");
        if (lexiconIndex < 0) return;
    
        const tail = link.href.slice(lexiconIndex + "/lexicon/".length);
        const strong = tail.split(/[?#/]/)[0];
        if (!/^[gh]\d+$/i.test(strong)) return;
    
        const criteriaUrl =
          blbSearchUrl + "?Criteria=" +
          encodeURIComponent(strong);
    
        openBlbDestinationFromContent(criteriaUrl);
      }, true);
    }
    
    // ---------- BLB Criteria Search ordinary verse links ----------
    // Criteria Search result verses are Suite-owned new-tab actions. Keep them
    // separate from the broad nowrap handler so each click has exactly one owner.
    if (
      location.hostname.endsWith(blbHostname) &&
      location.pathname.toLowerCase() === "/search/search.cfm"
    ) {
      document.addEventListener("click", e => {
        if (!getCachedEnabled() || isModifiedLinkActivation(e)) return;
    
        const link = e.target.closest?.('a[href]');
        if (!link || link.closest?.(".parse-popup")) return;
        if (!/\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href)) return;
    
        e.preventDefault();
        e.stopImmediatePropagation();
        openBlbDestinationFromContent(link.href);
      }, true);
    }
  }
});
