// Owns Suite-managed navigation for BLB Criteria Search result links.
(function (global) {
  function initialize({ BLB_HOSTNAME, isSuiteEnabledNow, isModifiedLinkActivation, openBlbDestinationFromContent }) {
  // ---------- BLB Criteria Search parsing-popup bridge ----------
  // Criteria Search is excluded from the normal BLB New Tab block above because
  // its page has its own navigation handlers. Handle only its parsing-popup
  // links here, using the same stable popup naming as normal BLB verse pages.
  // Do not intercept ordinary Criteria Search links.
  if (
    location.hostname.endsWith(BLB_HOSTNAME) &&
    location.pathname.toLowerCase() === "/search/search.cfm"
  ) {
    document.addEventListener("click", e => {
      if (!isSuiteEnabledNow() || isModifiedLinkActivation(e)) return;
  
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
        "https://www.blueletterbible.org/search/search.cfm?Criteria=" +
        encodeURIComponent(strong);
  
      openBlbDestinationFromContent(criteriaUrl);
    }, true);
  }
  
  // ---------- BLB Criteria Search ordinary verse links ----------
  // Criteria Search result verses are Suite-owned new-tab actions. Keep them
  // separate from the broad nowrap handler so each click has exactly one owner.
  if (
    location.hostname.endsWith(BLB_HOSTNAME) &&
    location.pathname.toLowerCase() === "/search/search.cfm"
  ) {
    document.addEventListener("click", e => {
      if (!isSuiteEnabledNow() || isModifiedLinkActivation(e)) return;
  
      const link = e.target.closest?.('a[href]');
      if (!link || link.closest?.(".parse-popup")) return;
      if (!/\/kjv\/[^/]+\/\d+\/\d+(?:\/|$)/i.test(link.href)) return;
  
      e.preventDefault();
      e.stopImmediatePropagation();
      openBlbDestinationFromContent(link.href);
    }, true);
  }
  }

  global.BLBCriteriaSearchNavigationModule = Object.freeze({ initialize });
})(globalThis);
