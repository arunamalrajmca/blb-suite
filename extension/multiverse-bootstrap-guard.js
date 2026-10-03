// BLB Suite MultiVerse bootstrap guard
(() => {
  try {
    const host = String(location.hostname || '').toLowerCase();
    const path = String(location.pathname || '');
    const isMultiVerse = host === 'www.blueletterbible.org' && /\/tools\/MultiVerse\.cfm$/i.test(path);
    const isSuiteMultiVerse = isMultiVerse && new URL(location.href).searchParams.get('blbSuiteMultiVerse') === '1';
    if (!isSuiteMultiVerse || !document.documentElement) return;
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
})();
