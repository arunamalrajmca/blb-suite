// Owns click routing for KJV verse links on the BLB MultiVerse tool page.
(function (global) {
  function initialize({ BLB_HOSTNAME, isSuiteEnabledNow, isModifiedLinkActivation, safeRuntimeSendMessage }) {
    if (
      !location.hostname.endsWith(BLB_HOSTNAME) ||
      !/\/tools\/MultiVerse\.cfm$/i.test(location.pathname)
    ) return;

    document.addEventListener("click", event => {
      if (!isSuiteEnabledNow() || isModifiedLinkActivation(event)) return;
      const link = event.target.closest?.('a[href*="/kjv/"]');
      if (!link || !link.href) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void safeRuntimeSendMessage({
        type: 'blbSuiteOpenMultiVerseVerse',
        url: link.href
      });
    }, true);
  }

  global.BLBMultiVerseToolViewModule = { initialize };
})(globalThis);
