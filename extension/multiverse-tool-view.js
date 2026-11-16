// Owns default Tool View selection and click routing for BLB MultiVerse pages.
(function (global) {
  function initialize({ BLB_HOSTNAME, isSuiteEnabledNow, isModifiedLinkActivation, safeRuntimeSendMessage }) {
    global.__blbMultiVerseToolViewCleanup?.();
    if (
      !location.hostname.endsWith(BLB_HOSTNAME) ||
      !/\/tools\/MultiVerse\.cfm$/i.test(location.pathname)
    ) return;

    const listenerController = new AbortController();
    let active = true;
    let finished = false;
    let retryTimer = 0;
    let loadListener = null;
    const stop = () => {
      finished = true;
      if (retryTimer) {
        window.clearInterval(retryTimer);
        retryTimer = 0;
      }
      if (loadListener) {
        window.removeEventListener("load", loadListener);
        loadListener = null;
      }
    };
    const cleanup = () => {
      if (!active) return;
      active = false;
      stop();
      listenerController.abort();
      if (global.__blbMultiVerseToolViewCleanup === cleanup) {
        delete global.__blbMultiVerseToolViewCleanup;
      }
    };
    global.__blbMultiVerseToolViewCleanup = cleanup;

    // Tool View is the default for every MultiVerse visit, including direct
    // visits and Suite-created tabs. This is a presentation default, so it
    // remains active even when the Suite's feature master switch is OFF.
    const root = document.documentElement;
    if (root.dataset.blbSuiteDefaultToolViewApplied !== "1") {
      let attempts = 0;

      const attempt = () => {
        if (!active || finished) return;
        attempts += 1;

        // BLB's .byVerseResults control switches TO Tool View. Once Tool
        // View is active BLB replaces it with .multiVerseResults, the action
        // that switches back. Do not reapply after the user changes views.
        if (document.querySelector("#formatButton.multiVerseResults")) {
          root.dataset.blbSuiteDefaultToolViewApplied = "1";
          stop();
          return;
        }

        const switchToToolView = document.querySelector("#formatButton.byVerseResults");
        if (switchToToolView) {
          try { switchToToolView.click(); } catch (_) {}
          if (document.querySelector("#formatButton.multiVerseResults")) {
            root.dataset.blbSuiteDefaultToolViewApplied = "1";
            stop();
            return;
          }
        }

        if (attempts >= 48) stop();
      };

      const start = () => {
        loadListener = null;
        if (!active || finished) return;
        attempt();
        if (!finished) retryTimer = window.setInterval(attempt, 250);
      };

      // BLB creates/rebinds its native format controls during page startup.
      // Wait for load, then retry for at most 12 seconds.
      if (document.readyState === "complete") start();
      else {
        loadListener = start;
        window.addEventListener("load", loadListener, { once: true });
      }
    }

    document.addEventListener("click", event => {
      if (!active || !isSuiteEnabledNow() || isModifiedLinkActivation(event)) return;
      const link = event.target.closest?.('a[href*="/kjv/"]');
      if (!link || !link.href) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void safeRuntimeSendMessage({
        type: 'blbSuiteOpenMultiVerseVerse',
        url: link.href
      });
    }, { capture: true, signal: listenerController.signal });
    return Object.freeze({ cleanup });
  }

  global.BLBMultiVerseToolViewModule = { initialize };
})(globalThis);
