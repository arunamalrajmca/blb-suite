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

  // ScriptTagger can wrap only the book name in a citation and give that
  // anchor a book-home URL (chapter 1, verse 1). When the surrounding citation
  // includes a specific chapter and verse, use it instead. Verse-part suffixes
  // such as a/b/c are labels, not part of the BLB destination.
  function contextualVerseDestination(link, fallbackUrl) {
    const bookText = String(link.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!bookText) return fallbackUrl;
    const context = String(link.parentElement?.textContent || '').replace(/\\s+/g, ' ');
    const escapedBook = bookText.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\  function isModifiedLinkActivation(event) {
    return Boolean(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  document.addEventListener('click', event => {');
    const pattern = new RegExp(`(?:^|[^A-Za-z])${escapedBook}\\\\s+(\\\\d+)\\\\s*:\\\\s*(\\\\d+)(?:[a-z])?(?=$|[^A-Za-z0-9])`, 'ig');
    let match;
    let lastMatch = null;
    while ((match = pattern.exec(context)) !== null) lastMatch = match;
    if (!lastMatch) return fallbackUrl;
    try {
      const parsed = new URL(fallbackUrl);
      const path = parsed.pathname.match(/^(.*\\/kjv\\/[^/]+\\/)\\d+\\/\\d+(\\/.*)$/i);
      if (!path) return fallbackUrl;
      parsed.pathname = `${path[1]}${Number(lastMatch[1])}/${Number(lastMatch[2])}${path[2]}`;
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
