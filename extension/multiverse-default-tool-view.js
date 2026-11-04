// Make BLB's native Tool View the default on every MultiVerse page.
// This intentionally does not depend on Suite settings or Suite-generated URL
// markers: direct visits and extension-created MultiVerse tabs behave alike.
(function (global) {
  function initialize() {
    if (
      location.hostname.toLowerCase() !== "www.blueletterbible.org" ||
      !/^\/tools\/MultiVerse\.cfm$/i.test(location.pathname)
    ) return;

    const root = document.documentElement;
    if (root.dataset.blbSuiteDefaultToolViewApplied === "1") return;

    let finished = false;
    let attempts = 0;
    let retryTimer = 0;

    const stop = () => {
      finished = true;
      if (retryTimer) {
        window.clearInterval(retryTimer);
        retryTimer = 0;
      }
    };

    const attempt = () => {
      if (finished) return;
      attempts += 1;

      // BLB exposes .byVerseResults as the action to switch TO Tool View and
      // .multiVerseResults as the action to switch back. Do not click when
      // Tool View is already active, and stop permanently after switching so
      // a later manual user choice is never overridden.
      const toolViewActive = document.querySelector("#formatButton.multiVerseResults");
      if (toolViewActive) {
        root.dataset.blbSuiteDefaultToolViewApplied = "1";
        stop();
        return;
      }

      const switchToToolView = document.querySelector("#formatButton.byVerseResults");
      if (switchToToolView) {
        try {
          switchToToolView.click();
        } catch (_) {}
        if (document.querySelector("#formatButton.multiVerseResults")) {
          root.dataset.blbSuiteDefaultToolViewApplied = "1";
          stop();
          return;
        }
      }

      if (attempts >= 48) stop();
    };

    const start = () => {
      if (finished) return;
      attempt();
      if (!finished) retryTimer = window.setInterval(attempt, 250);
    };

    // BLB creates/rebinds its format controls during native page startup.
    // Begin after load and allow a bounded 12-second initialization window.
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
  }

  global.BLBMultiVerseDefaultToolViewModule = { initialize };
})(globalThis);
