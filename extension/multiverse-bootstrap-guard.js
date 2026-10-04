// BLB Suite MultiVerse bootstrap guard
(() => {
  try {
    const host = String(location.hostname || '').toLowerCase();
    const path = String(location.pathname || '');
    const isMultiVerse = host === 'www.blueletterbible.org' && /\/tools\/MultiVerse\.cfm$/i.test(path);
    const isSuiteMultiVerse = isMultiVerse && new URL(location.href).searchParams.get('blbSuiteMultiVerse') === '1';
    if (!isSuiteMultiVerse || !document.documentElement) return;

    // Suite OFF must be indistinguishable from the extension not being present.
    // This guard runs before content.js, so consult the master switch itself and
    // never hide native MultiVerse while the Suite is disabled.
    chrome.storage.local.get({masterEnabled:true}).then(({masterEnabled}) => {
      if (masterEnabled === false || !document.documentElement) return;
      try {
        document.documentElement.dataset.blbSuiteMultiVersePending = '1';
        document.documentElement.style.visibility = 'hidden';
        window.setTimeout(() => {
          try {
            if (document.documentElement.dataset.blbSuiteMultiVersePending === '1') {
              document.documentElement.style.visibility = '';
              delete document.documentElement.dataset.blbSuiteMultiVersePending;
            }
          } catch (_) {}
        }, 12000);
      } catch (_) {}
    }).catch(() => {
      // Fail closed: storage failure must never make this Suite-owned page
      // initialization override active while the master state is unknown.
    });
  } catch (_) {}
})();
