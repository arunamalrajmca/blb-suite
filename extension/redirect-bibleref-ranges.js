// Recover visible verse ranges from BibleRef links on ordinary article pages.
// Kept separate from redirect-scripttagger.js so generic BibleRef handling
// cannot change ScriptTagger click behavior.
(() => {
  if (globalThis.__blbSuiteBibleRefRangeRedirectLoaded) return;
  globalThis.__blbSuiteBibleRefRangeRedirectLoaded = true;

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

  function isModifiedLinkActivation(event) {
    return Boolean(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  function preserveVisibleBibleRefRange(link) {
    try {
      const url = new URL(link.href);
      if (!['bibleref.com', 'www.bibleref.com'].includes(url.hostname.toLowerCase())) return false;

      const pathMatch = url.pathname.match(/^\/([^/]+)\/(\d+)\/([^/]+)-(\d+)-(\d+)\.html$/i);
      if (!pathMatch) return false;

      const citation = String(link.textContent || '').replace(/\s+/g, ' ').trim();
      const rangeMatch = citation.match(/\b((?:[1-3]\s*)?[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+)\s*:\s*(\d+)\s*[-\u2010-\u2015]\s*(\d+)\b/);
      if (!rangeMatch) return false;

      const normalizeBook = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const urlBook = normalizeBook(pathMatch[3]);
      const textBook = normalizeBook(rangeMatch[1]);
      const chapter = Number(pathMatch[2]);
      const slugChapter = Number(pathMatch[4]);
      const startVerse = Number(pathMatch[5]);
      const textChapter = Number(rangeMatch[2]);
      const textStart = Number(rangeMatch[3]);
      const endVerse = Number(rangeMatch[4]);

      // Only upgrade a single-verse URL when the visible reference matches it.
      if (
        textBook !== urlBook ||
        slugChapter !== chapter ||
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

  document.addEventListener('click', event => {
    if (!settingsReady || !masterEnabled || !redirectEnabled || isModifiedLinkActivation(event)) return;
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    preserveVisibleBibleRefRange(link);
  }, true);
})();
