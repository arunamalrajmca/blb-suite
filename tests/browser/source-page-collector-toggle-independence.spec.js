const { test, expect } = require('./fixtures');

test('registered source-page collection buttons are independent of external-link redirect preference', async ({
  extensionWorker
}) => {
  const cases = await extensionWorker.evaluate(() => {
    const tab = {url:'https://dailyverses.net/dailyverse'};
    const collectorFiles = [];

    for (const redirectEnabled of [false, true]) {
      const settings = {
        masterEnabled:true,
        pageSelectionButtonSites:{},
        doubleClickBlbSites:{},
        redirectEnabled
      };
      const shouldInject = shouldInjectContentScriptForTab(tab, settings);
      const files = contentScriptFilesForTab(tab, settings);
      collectorFiles.push({
        redirectEnabled,
        shouldInject,
        hasCollectorBundle:files.includes('content.js'),
        hasRedirectBundle:files.includes('script-tagger.js'),
        hasCollectorRegistry:Object.prototype.hasOwnProperty.call(
          globalThis.BLBSourcePageCollectorSites || {}, 'dailyverses.net'
        )
      });
    }

    return collectorFiles;
  });

  expect(cases).toEqual([
    {
      redirectEnabled:false,
      shouldInject:true,
      hasCollectorBundle:true,
      hasRedirectBundle:false,
      hasCollectorRegistry:true
    },
    {
      redirectEnabled:true,
      shouldInject:true,
      hasCollectorBundle:true,
      hasRedirectBundle:true,
      hasCollectorRegistry:true
    }
  ]);
});

test('source-page collection button lifecycle is controlled by SUITE master state, not redirect preference', async ({
  extensionWorker
}) => {
  const lifecycle = await extensionWorker.evaluate(() => {
    const source = globalThis.BLBSourcePageCollectorModule?.initialize?.toString?.() || '';
    const registry = globalThis.BLBSourcePageCollectorSites || {};
    const site = registry['dailyverses.net'];
    return {
      registeredSite:!!site,
      collectorGateUsesMaster:source.includes('changes.masterEnabled?.newValue'),
      collectorGateUsesRedirect:source.includes('redirectEnabled')
    };
  });

  expect(lifecycle.registeredSite).toBe(true);
  expect(lifecycle.collectorGateUsesMaster).toBe(true);
  expect(lifecycle.collectorGateUsesRedirect).toBe(false);
});
