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

  // BibleRef links on article pages sometimes display a verse range while
  // their href points only to the first verse. Upgrade only when the visible
  // citation agrees with the BibleRef URL's book, chapter, and starting verse.
  // The existing BibleRef-page redirect will then carry the full range to BLB.
  function preserveBibleRefVisibleRange(link) {
    try {
      const url = new URL(link.href);
      if (!['bibleref.com', 'www.bibleref.com'].includes(url.hostname.toLowerCase())) return false;

      const pathMatch = url.pathname.match(/^\/([^/]+)\/(\d+)\/([^/]+)-(\d+)-(\d+)\.html$/i);
      if (!pathMatch) return false;

      const citation = String(link.textContent || '').replace(/\s+/g, ' ').trim();
      const rangeMatch = citation.match(/\b((?:[1-3]\s*)?[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+)\s*:\s*(\d+)\s*[-\u2010-\u2015]\s*(\d+)\b/);
      if (!rangeMatch) return false;

      const normalizeBook = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const urlBook = pathMatch[3].replace(new RegExp('-' + pathMatch[4] + '-' + pathMatch[5] + '
})();
, 'i'), '');
      const textBook = normalizeBook(rangeMatch[1]);
      const slugBook = normalizeBook(urlBook);
      const chapter = Number(pathMatch[2]);
      const startVerse = Number(pathMatch[5]);
      const textChapter = Number(rangeMatch[2]);
      const textStart = Number(rangeMatch[3]);
      const endVerse = Number(rangeMatch[4]);

      if (
        textBook !== slugBook ||
        Number(pathMatch[4]) !== chapter ||
        textChapter !== chapter ||
        textStart !== startVerse ||
        endVerse <= startVerse
      ) return false;

      url.pathname = url.pathname.replace(/-(\d+)\.html$/i, '-' + startVerse + '-' + endVerse + '.html');
      link.href = url.href;
      return true;
    } catch (_) {
      return false;
    }
  }

  function isModifiedLinkActivation(event) {
    return Boolean(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  document.addEventListener('click', event => {
    if (!settingsReady || !masterEnabled || !redirectEnabled || isModifiedLinkActivation(event)) return;
    const link = event.target.closest?.('a[href]');
    if (!link) return;

    // Preserve a displayed BibleRef range before native navigation. Do not
    // cancel the click: the destination page's existing redirect owns BLB opening.
    if (preserveBibleRefVisibleRange(link)) return;

    // ScriptTagger links already targeting BLB keep their existing handling.
    if (!link.matches('a.BLBST_a[href]')) return;
    const target = normalizeBlbDestinationUrl(link.href);
    if (!target) return;
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
