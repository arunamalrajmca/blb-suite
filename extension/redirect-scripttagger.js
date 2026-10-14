// Minimal global ScriptTagger redirect handler.
// Injected on ordinary websites only while global redirection is enabled.
(() => {
  if (globalThis.__blbSuiteScriptTaggerRedirectLoaded) return;
  globalThis.__blbSuiteScriptTaggerRedirectLoaded = true;

  let masterEnabled = true;
  let redirectEnabled = false;
  let settingsReady = false;

  const refreshSettings = async () => {
    settingsReady = false;
    try {
      const settings = await chrome.storage.local.get({masterEnabled:true, redirectEnabled:false});
      masterEnabled = settings.masterEnabled !== false;
      redirectEnabled = settings.redirectEnabled === true;
    } catch (_) {
      masterEnabled = false;
      redirectEnabled = false;
    } finally {
      settingsReady = true;
    }
  };
  void refreshSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes.masterEnabled || changes.redirectEnabled)) void refreshSettings();
  });

  function normalizeBlbDestinationUrl(url) {
    const target = String(url || '').trim();
    try {
      const parsed = new URL(target);
      if (!/^https?:$/.test(parsed.protocol)) return '';
      const hostname = parsed.hostname.toLowerCase();
      if (!['blueletterbible.org', 'www.blueletterbible.org', 'blueletterbible.com', 'www.blueletterbible.com'].includes(hostname)) return '';
      parsed.protocol = 'https:';
      parsed.hostname = 'www.blueletterbible.org';
      parsed.port = '';
      return parsed.href;
    } catch (_) {
      return '';
    }
  }

  function isModifiedLinkActivation(event) {
    return Boolean(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  // ScriptTagger may wrap only the book name in a citation and give that
  // anchor a book-home URL (chapter 1, verse 1). Prefer the chapter and verse
  // in the surrounding citation when available. A verse-part suffix (a/b/c)
  // is a label, not part of the destination.
  function contextualVerseDestination(link, fallbackUrl) {
    const bookText = String(link.textContent || '').replace(/\s+/g, ' ').trim();
    if (!bookText) return fallbackUrl;

    // The anchor may contain only the book name while the reference is in a
    // sibling or a higher-level Facebook post container. Search ancestors.
    const escapedBook = bookText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('(?:^|[^A-Za-z])' + escapedBook + '\\s+(\\d+)\\s*:\\s*(\\d+)(?:[a-z])?(?=$|[^A-Za-z0-9])', 'ig');
    let lastMatch = null;
    let node = link.parentElement;

    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      const context = String(node.textContent || '').replace(/\s+/g, ' ');
      let match;
      let candidate = null;
      while ((match = pattern.exec(context)) !== null) candidate = match;
      pattern.lastIndex = 0;
      if (candidate) {
        lastMatch = candidate;
        break;
      }
    }

    if (!lastMatch) return fallbackUrl;
    try {
      const parsed = new URL(fallbackUrl);
      const path = parsed.pathname.match(/^(.*\/kjv\/[^/]+\/)\d+\/\d+(\/.*)$/i);
      if (!path) return fallbackUrl;
      parsed.pathname = path[1] + Number(lastMatch[1]) + '/' + Number(lastMatch[2]) + path[2];
      return parsed.href;
    } catch (_) {
      return fallbackUrl;
    }
  }

  document.addEventListener('click', event => {
    if (!settingsReady || !masterEnabled || !redirectEnabled || isModifiedLinkActivation(event)) return;
    const link = event.target.closest?.('a.BLBST_a[href]');
    if (!link) return;
    const normalizedTarget = normalizeBlbDestinationUrl(link.href);
    if (!normalizedTarget) return;
    const target = contextualVerseDestination(link, normalizedTarget);
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const pending = chrome.runtime.sendMessage({
        type:'blbSuiteOpenScriptTaggerUrl',
        url:target,
        activeIfNew:true,
        activateExisting:true
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (_) {}
  }, true);
})();
