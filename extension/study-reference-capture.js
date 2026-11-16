// Captures useful BLB Bible and Strong's destinations while a named Study Topic is active.
// Navigation/result based: no click logging, polling, or page-wide MutationObserver.
(function (global) {
  function initialize({ BLB_HOSTNAME, normalizeSelectionText, isSuiteEnabled, isSuiteEnabledNow = isSuiteEnabled }) {
    global.__blbStudyReferenceCaptureCleanup?.();
    let active = true;
    const pendingTimers = new Map();
    let startupListener = null;
    const cleanup = () => {
      if (!active) return;
      active = false;
      if (startupListener) {
        document.removeEventListener('DOMContentLoaded', startupListener);
        startupListener = null;
      }
      for (const [timer, resolve] of pendingTimers) {
        clearTimeout(timer);
        resolve(false);
      }
      pendingTimers.clear();
      if (global.__blbStudyReferenceCaptureCleanup === cleanup) {
        delete global.__blbStudyReferenceCaptureCleanup;
      }
    };
    global.__blbStudyReferenceCaptureCleanup = cleanup;

    const waitForRetry = () => new Promise(resolve => {
      if (!active) { resolve(false); return; }
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        resolve(active);
      }, 100);
      pendingTimers.set(timer, resolve);
    });

    const sendCaptureMessage = async message => {
      let lastError = null;
      for (let attempt = 0; attempt < 2 && active; attempt++) {
        try {
          const response = await chrome.runtime.sendMessage(message);
          if (!active) return null;
          if (response?.ok !== false) return response;
          lastError = new Error(response.error || 'Study capture request was rejected');
        } catch (error) {
          if (!active) return null;
          lastError = error;
        }
        if (attempt === 0 && !(await waitForRetry())) return null;
      }
      if (active) throw lastError || new Error('Study capture message failed');
      return null;
    };
  // // ---------- Study reference capture ----------
  // Capture only useful BLB Bible/Strong's destinations while a named Study Topic
  // is active. This is deliberately navigation/result based: no click logging,
  // polling, or page-wide MutationObserver is used for the audit.
  if (location.hostname.toLowerCase().replace(/^www\./,'') === BLB_HOSTNAME) {
    const captureStudyRefs = async () => {
      try {
        if (!active || !(await isSuiteEnabled()) || !active || !isSuiteEnabledNow()) return;
        const captureState = await sendCaptureMessage({type:'blbSuiteStudyCaptureActive'});
        if (!captureState?.active || !active || !isSuiteEnabledNow()) return;
  
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
          if (criteria && active && isSuiteEnabledNow()) await sendCaptureMessage({type:'blbSuiteCaptureStudySearchTerm', term:criteria});
          return;
        }
  
        // Current Bible page / redirected Bible page only. Search and MultiVerse
        // result lists are deliberately not bulk-captured.
        addUrl(location.href);
        if (refs.size && active && isSuiteEnabledNow()) await sendCaptureMessage({type:'blbSuiteCaptureStudyRefs', refs:[...refs.values()]});
      } catch (_) {}
    };
  
    const captureStrong = async () => {
      try {
        if (!active || !(await isSuiteEnabled()) || !active || !isSuiteEnabledNow()) return;
        const captureState = await sendCaptureMessage({type:'blbSuiteStudyCaptureActive'});
        if (!captureState?.active || !active || !isSuiteEnabledNow()) return;
        const m = location.pathname.match(/\/lexicon\/(g|h)(\d+)\//i);
        if (m && active && isSuiteEnabledNow()) await sendCaptureMessage({type:'blbSuiteCaptureStudyStrong', value:`${m[1]}${m[2]}`});
      } catch (_) {}
    };
  
    const runStudyCapture = () => {
      if (!active) return;
      void captureStudyRefs();
      void captureStrong();
    };
    if (document.readyState === 'loading') {
      startupListener = runStudyCapture;
      document.addEventListener('DOMContentLoaded', startupListener, {once:true});
    } else {
      runStudyCapture();
    }
    return Object.freeze({ refresh: runStudyCapture, cleanup });
  }
  }

  global.BLBStudyReferenceCaptureModule = Object.freeze({ initialize });
})(globalThis);
