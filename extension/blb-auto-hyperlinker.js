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
    if (!(location.hostname.endsWith(BLBShared.hostnames.blb) &&
        !/(?:\/search\/(?:search|preSearch)\.cfm|\/tools\/MultiVerse\.cfm)$/i.test(location.pathname))) return;

    // The cached master flag starts fail-closed and is populated asynchronously.
    // Register the synchronous copy handler only after that initial read settles,
    // so a page cannot apply Suite clipboard formatting during initialization.
    Promise.resolve(suiteSettingsReadyPromise).catch(() => {}).then(() => {
      document.addEventListener("copy", e => {
        if (!isSuiteEnabledNow()) return;
        const text = window.getSelection()?.toString() || "";
        const html = formatBlbTextToHtml(text, BLBShared);
        if (!html || !e.clipboardData) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.clipboardData.setData("text/html", html);
        e.clipboardData.setData("text/plain", text);
      }, true);
    });

    if (navigator.clipboard?.writeText) {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async text => {
        if (!(await isSuiteEnabled())) return original(text);
        const html = formatBlbTextToHtml(text, BLBShared);
        if (!html) return original(text);
        const handler = e => {
          e.clipboardData.setData("text/html", html);
          e.clipboardData.setData("text/plain", text);
          e.preventDefault();
        };
        document.addEventListener("copy", handler, true);
        document.execCommand("copy");
        document.removeEventListener("copy", handler, true);
      };
    }
  }
  global.BLBAutoHyperlinkerModule = Object.freeze({ initialize });
})(globalThis);
