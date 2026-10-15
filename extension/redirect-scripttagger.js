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

  // Some ScriptTagger integrations link a visible verse range to only its
  // first verse. Recover the range from the link's own citation text, but only
  // when its chapter and starting verse match the destination URL.
  function preserveVisibleVerseRange(link, target) {
    try {
      const url = new URL(target);
      const pathMatch = url.pathname.match(/^(\\/kjv\\/[^/]+\\/(\\d+)\\/)(\\d+)(?:\\/s_\\d+)?\\/?$/i);
      if (!pathMatch) return target;

      const text = String(link?.textContent || '').replace(/\\s+/g, ' ').trim();
      const rangeMatch = text.match(/\\b(\\d+)\\s*:\\s*(\\d+)\\s*[-\\u2010-\\u2015]\\s*(\\d+)\\b/);
      if (!rangeMatch) return target;

      const chapter = Number(pathMatch[2]);
      const startVerse = Number(pathMatch[3]);
      const textChapter = Number(rangeMatch[1]);
      const textStart = Number(rangeMatch[2]);
      const endVerse = Number(rangeMatch[3]);
      if (textChapter !== chapter || textStart !== startVerse || endVerse <= startVerse) return target;

      url.pathname = pathMatch[1] + startVerse + '-' + endVerse + '/';
      return url.href;
    } catch (_) {
      return target;
    }
  }

  function isModifiedLinkActivation(event) {
    return Boolean(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  document.addEventListener('click', event => {
    if (!settingsReady || !masterEnabled || !redirectEnabled || isModifiedLinkActivation(event)) return;
    const link = event.target.closest?.('a.BLBST_a[href]');
    if (!link) return;
    const normalizedTarget = normalizeBlbDestinationUrl(link.href);
    if (!normalizedTarget) return;
    const target = preserveVisibleVerseRange(link, normalizedTarget);
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
