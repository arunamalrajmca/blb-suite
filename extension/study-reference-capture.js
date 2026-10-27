// Captures useful BLB Bible and Strong's destinations while a named Study Topic is active.
// Navigation/result based: no click logging, polling, or page-wide MutationObserver.
(function (global) {
  function initialize({ BLB_HOSTNAME, normalizeSelectionText, isSuiteEnabled }) {
  // // ---------- Study reference capture ----------
  // Capture only useful BLB Bible/Strong's destinations while a named Study Topic
  // is active. This is deliberately navigation/result based: no click logging,
  // polling, or page-wide MutationObserver is used for the audit.
  if (location.hostname.toLowerCase().replace(/^www\./,'') === BLB_HOSTNAME) {
    const captureStudyRefs = async () => {
      try {
        if (!(await isSuiteEnabled())) return;
        const active = await chrome.runtime.sendMessage({type:'blbSuiteStudyCaptureActive'});
        if (!active?.active) return;
  
        const refs = new Map();
        const addUrl = href => {
          try {
            const u = new URL(String(href || ''), location.href);
            const host = u.hostname.toLowerCase().replace(/^www\./,'');
            if (host !== BLB_HOSTNAME) return;
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts.length < 3 || parts[0].toLowerCase() !== 'kjv' || !/^\d+$/.test(parts[2])) return;
            // Verse/result links have a verse component. Chapter links are handled
            // from the current page URL only, so navigation menus do not pollute
            // search-result capture.
            if (parts.length < 4) return;
            const vm = String(parts[3]).match(/^(\d+)(?:-(\d+))?$/);
            if (!vm) return;
            const key = `${parts[1].toLowerCase()}|${parts[2]}|${vm[1]}|${vm[2] || vm[1]}`;
            refs.set(key,{urlKey:parts[1].toLowerCase(),chapter:Number(parts[2]),from:Number(vm[1]),to:Number(vm[2] || vm[1]),version:'kjv'});
          } catch (_) {}
        };
  
        // Native BLB Search: record only the search term, never the potentially
        // enormous set of verses returned by the search.
        if (/\/search\/(?:search|preSearch)\.cfm/i.test(location.pathname)) {
          const currentUrl = new URL(location.href);
          // MultiVerse intentionally opens BLB's search page with a temporary
          // default Criteria=Jesus before populating the real MultiVerse inputs.
          // That bootstrap term is not a user search and must never enter Study
          // History.
          if (currentUrl.searchParams.get('blbSuiteMultiVerse') === '1') return;
          const criteria = normalizeSelectionText(String(currentUrl.searchParams.get('Criteria') || '').replace(/\+/g, ' '));
          if (criteria) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudySearchTerm', term:criteria});
          return;
        }
  
        // Current Bible page / redirected Bible page only. Search and MultiVerse
        // result lists are deliberately not bulk-captured.
        addUrl(location.href);
        if (refs.size) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudyRefs', refs:[...refs.values()]});
      } catch (_) {}
    };
  
    const captureStrong = async () => {
      try {
        if (!(await isSuiteEnabled())) return;
        const active = await chrome.runtime.sendMessage({type:'blbSuiteStudyCaptureActive'});
        if (!active?.active) return;
        const m = location.pathname.match(/\/lexicon\/(g|h)(\d+)\//i);
        if (m) await chrome.runtime.sendMessage({type:'blbSuiteCaptureStudyStrong', value:`${m[1]}${m[2]}`});
      } catch (_) {}
    };
  
    const runStudyCapture = () => { captureStudyRefs(); captureStrong(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',runStudyCapture,{once:true});
    else runStudyCapture();
  }
  }

  global.BLBStudyReferenceCaptureModule = Object.freeze({ initialize });
})(globalThis);
