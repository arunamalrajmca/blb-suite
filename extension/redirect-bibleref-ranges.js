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

      const rangePattern = /\b((?:[1-3]\s*)?[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+)\s*:\s*(\d+)\s*[-\u2010-\u2015]\s*(\d+)\b/;
      // Some article layouts place part of the visible citation outside the
      // anchor (for example, the linked start verse followed by an unlinked
      // range suffix). Check the anchor first, then nearby text containers.
      const citationTexts = [
        link.textContent,
        link.parentElement?.textContent,
        link.parentElement?.parentElement?.textContent
      ];
      let rangeMatch = null;
      for (const text of citationTexts) {
        rangeMatch = String(text || '').replace(/\s+/g, ' ').trim().match(rangePattern);
        if (rangeMatch) break;
      }
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
      return url.href;
    } catch (_) {
      return false;
    }
  }

  document.addEventListener('click', event => {
    if (!settingsReady || !masterEnabled || !redirectEnabled || isModifiedLinkActivation(event)) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const link = target?.closest?.('a[href]');
    if (!link) return;
    const rangeUrl = preserveVisibleBibleRefRange(link);
    if (!rangeUrl) return;

    // Open the final BLB destination through the Suite's existing deduplicating
    // tab manager instead of navigating to BibleRef first and triggering a
    // second redirect-created tab.
    event.preventDefault();
    event.stopImmediatePropagation();
    chrome.runtime.sendMessage({
      type: 'blbSuiteOpenBibleRefRange',
      url: rangeUrl,
      activeIfNew: true,
      activateExisting: true
    }).then(response => {
      if (!response?.ok) {
        console.warn('[BLB Suite] BibleRef range redirect was rejected; opening the original link.', response);
        window.location.assign(link.href);
      }
    }).catch(error => {
      console.warn('[BLB Suite] Could not open BibleRef range; opening the original link.', error);
      window.location.assign(link.href);
    });
  }, true);
})();
