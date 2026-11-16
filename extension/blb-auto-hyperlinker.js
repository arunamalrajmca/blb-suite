// Owns rich-HTML clipboard formatting for Bible references copied from BLB.
(function (global) {
  function formatBlbTextToHtml(rawText, BLBShared) {
    const refs = rawText.match(/\b(?:[1-3]\s*|i{1,3}\s*)?[A-Za-z0-9.]+\s+\d+:\d+(?:-\d+)?\b/gi);
    if (!refs) return null;
    let html = rawText;
    refs.forEach(ref => {
      const x = ref.trim(), i = x.lastIndexOf(" ");
      if (i < 0) return;
      const book = x.slice(0, i).replace(/\./g, "").replace(/\s+/g, "");
      const cv = x.slice(i + 1).replace(":", "/");
      html = html.replace(ref, `<a href="${BLBShared.urls.blbHome}kjv/${book}/${cv}/" style="color:#1155cc;text-decoration:underline;">${ref}</a>`);
    });
    html = html.replace(/\n/g, "<br>");
    return `<!DOCTYPE html><html><body><!--StartFragment--><span style="font-family:Arial,sans-serif;">${html}</span><!--EndFragment--></body></html>`;
  }

  function initialize({ BLBShared, isSuiteEnabledNow, isSuiteEnabled, suiteSettingsReadyPromise }) {
    global.__blbAutoHyperlinkerCleanup?.();
    let active = true;
    const listenerController = new AbortController();
    const clipboard = navigator.clipboard;
    const originalWriteText = clipboard?.writeText;
    let wrappedWriteText = null;

    const cleanup = () => {
      if (!active) return;
      active = false;
      listenerController.abort();
      // Restore only our own wrapper; do not overwrite a later third-party patch.
      if (clipboard && wrappedWriteText && clipboard.writeText === wrappedWriteText) {
        clipboard.writeText = originalWriteText;
      }
      if (global.__blbAutoHyperlinkerCleanup === cleanup) {
        delete global.__blbAutoHyperlinkerCleanup;
      }
    };
    global.__blbAutoHyperlinkerCleanup = cleanup;

    if (!(location.hostname.endsWith(BLBShared.hostnames.blb) &&
        !/(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname))) {
      return Object.freeze({ cleanup });
    }

    // The cached master flag starts fail-closed and is populated asynchronously.
    // Register the synchronous copy handler only after that initial read settles,
    // so a page cannot apply Suite clipboard formatting during initialization.
    const copyHandler = e => {
      if (!active || !isSuiteEnabledNow()) return;
      const text = window.getSelection()?.toString() || "";
      const html = formatBlbTextToHtml(text, BLBShared);
      if (!html || !e.clipboardData) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.clipboardData.setData("text/html", html);
      e.clipboardData.setData("text/plain", text);
    };
    Promise.resolve(suiteSettingsReadyPromise).catch(() => {}).then(() => {
      if (active) {
        document.addEventListener("copy", copyHandler, {
          capture: true,
          signal: listenerController.signal
        });
      }
    });

    if (clipboard && typeof originalWriteText === "function") {
      wrappedWriteText = async text => {
        if (!active || !(await isSuiteEnabled()) || !active) {
          return originalWriteText.call(clipboard, text);
        }
        const html = formatBlbTextToHtml(text, BLBShared);
        if (!html) return originalWriteText.call(clipboard, text);
        const handler = e => {
          if (!e.clipboardData) return;
          e.clipboardData.setData("text/html", html);
          e.clipboardData.setData("text/plain", text);
          e.preventDefault();
        };
        document.addEventListener("copy", handler, true);
        try {
          document.execCommand("copy");
        } finally {
          document.removeEventListener("copy", handler, true);
        }
      };
      clipboard.writeText = wrappedWriteText;
    }

    return Object.freeze({ cleanup });
  }
  global.BLBAutoHyperlinkerModule = Object.freeze({ initialize });
})(globalThis);
