// Host policy and ordered content-script bundles for the MV3 service worker.
globalThis.BLBBackgroundHostPolicyModule = Object.freeze({
  create({ blbHostname }) {
    const contentScriptFiles = [
      'regex-patterns.js',
      'kjv-corpus-word-index.js',
      'books.js',
      'book-aliases.js',
      'reference-core.js',
      'kings-bible-collector.js',
      'webster-collector.js',
      'source-page-collector.js',
      'multiverse-copy-links.js',
      'blb-auto-hyperlinker.js',
      'blb-parse-popup-links.js',
      'blb-navigation-links.js',
      'blb-new-tab-links.js',
      'blb-multiverse-handoff.js',
      'blb-passive-new-tab.js',
      'content.js'
    ];
    const scriptTaggerFiles = ['redirect-scripttagger.js'];
    const bibleRefRangeFiles = ['redirect-bibleref-ranges.js'];
    const redirectHostnames = new Set([
      'bible.com', 'biblegateway.com', 'bibleref.com',
      'biblehub.com', 'bibleportal.com',
      'christianity.com', 'crosswalk.com', 'enduringword.com', 'esv.org', 'gotquestions.org',
      'rediscover.bible', 'sagacityweb.com', 'thetreasuryofscriptureknowledge.com',
      'kingjamesbibleonline.org', 'kjbo.org',
      'kjv.site', 'm.kjv.site',
      'officialkingjamesbible.com', 'thekingsbible.com',
      'webstersdictionary1828.com', blbHostname
    ]);
    return Object.freeze({
      contentScriptFiles,
      scriptTaggerFiles,
      bibleRefRangeFiles,
      redirectHostnames,
      isRedirectHostname(hostname, normalizeSiteHostname) {
        return redirectHostnames.has(normalizeSiteHostname(String(hostname || '')));
      },
      contentScriptFilesForTab(tab, data, { hostnameFromTabUrl, normalizeSiteHostname, isSensitiveSiteHostname }) {
        const hostname = hostnameFromTabUrl(tab?.url);
        const key = normalizeSiteHostname(hostname);
        const pageSites = data.pageSelectionButtonSites && typeof data.pageSelectionButtonSites === 'object'
          ? data.pageSelectionButtonSites : {};
        const doubleSites = data.doubleClickBlbSites && typeof data.doubleClickBlbSites === 'object'
          ? data.doubleClickBlbSites : {};
        const sensitiveSite = isSensitiveSiteHostname(hostname);
        const blbSite = key === blbHostname;
        const explicitSiteFeature = blbSite ? pageSites[key] === true : !sensitiveSite && (pageSites[key] === true || doubleSites[key] === true);
        const redirectEnabled = data.redirectEnabled === true;
        const needsFullBundle = explicitSiteFeature || (redirectEnabled && this.isRedirectHostname(hostname, normalizeSiteHostname));
        if (needsFullBundle && redirectEnabled) {
          return [...contentScriptFiles, ...scriptTaggerFiles, ...bibleRefRangeFiles];
        }
        if (needsFullBundle) return contentScriptFiles;
        if (redirectEnabled) return [...scriptTaggerFiles, ...bibleRefRangeFiles];
        return [];
      }
    });
  }
});
