const { test, expect } = require('./fixtures');

test('registered source-page collector remains available regardless of redirect preference', async ({
  extensionWorker
}) => {
  const cases = await extensionWorker.evaluate(async () => {
    const tab = {url:'https://www.dailyverses.net/dailyverse'};
    const results = [];

    for (const redirectEnabled of [false, true]) {
      const settings = {
        masterEnabled:true,
        pageSelectionButtonSites:{},
        doubleClickBlbSites:{},
        redirectEnabled
      };
      const files = contentScriptFilesForTab(tab, settings);
      const shouldInject = await shouldInjectContentScriptForTab(tab, settings);
      results.push({
        redirectEnabled,
        shouldInject,
        hasCollectorBundle:files.includes('content.js') &&
          files.includes('source-page-collector.js'),
        hasRedirectBundle:files.includes('redirect-scripttagger.js') &&
          files.includes('redirect-bibleref-ranges.js'),
        hasCollectorRegistry:Object.prototype.hasOwnProperty.call(
          globalThis.BLBSourcePageCollectorSites || {}, 'dailyverses.net'
        )
      });
    }

    return results;
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

test('Open Bible References in BLB remains visible across redirect changes and follows SUITE master', async ({
  page, extensionStorage
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route('https://www.dailyverses.net/dailyverse', route =>
    route.fulfill({
      status:200,
      contentType:'text/html',
      body:'<!doctype html><html><head><title>Daily verse test</title></head><body><main>Daily verse</main></body></html>'
    })
  );
  await page.goto('https://www.dailyverses.net/dailyverse', {waitUntil:'domcontentloaded'});

  const button = page.locator('#blb-suite-dailyverses-multiverse');
  await expect(button).toBeVisible();

  await extensionStorage.set({redirectEnabled:true});
  await expect(button).toBeVisible();

  await extensionStorage.set({redirectEnabled:false});
  await expect(button).toBeVisible();

  // Model a stale/missing page control after the redirect toggle is changed
  // from this same site. Re-enabling redirects refreshes the active tab through
  // ensureContentScriptInTab(), whose resident-script message must also refresh
  // the source-page collector rather than only selection features.
  await button.evaluate(element => element.remove());
  await expect(button).toHaveCount(0);
  await extensionStorage.set({redirectEnabled:true});
  const result = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
    return tabs[0]?.id == null ? false : ensureContentScriptInTab(tabs[0].id);
  });
  expect(result).toBe(true);
  await expect(button).toBeVisible();

  await extensionStorage.set({redirectEnabled:false});
  await expect(button).toBeVisible();

  await extensionStorage.set({masterEnabled:false});
  await expect(button).toHaveCount(0);

  await extensionStorage.set({masterEnabled:true});
  await expect(button).toBeVisible();
});


test('same-tab redirect re-enable refresh restores source-page buttons on every registered host', async ({
  page, extensionWorker, extensionStorage
}) => {
  const cases = [
    ['https://www.christianity.com/wiki/prayer/test-article.html', 'christianity'],
    ['https://www.gotquestions.org/test-article.html', 'gotquestions'],
    ['https://www.crosswalk.com/devotionals/test-article.html', 'crosswalk'],
    ['https://www.enduringword.com/bible-commentary/genesis-1/', 'enduringword'],
    ['https://www.rediscover.bible/articles/test-article', 'rediscover'],
    ['https://sagacityweb.com/articles/test-article', 'sagacity'],
    ['https://www.thetreasuryofscriptureknowledge.com/articles/test-article', 'treasury'],
    ['https://www.dailyverses.net/dailyverse', 'dailyverses'],
    ['https://www.churchofjesuschrist.org/study/scriptures/ot/gen/1?lang=eng', 'churchofjesuschrist'],
    ['https://mercyhouseministry.com/articles/test-article', 'mercyhouse'],
    ['https://www.openbible.info/topics/test-article', 'openbible'],
    ['https://www.crossway.org/articles/test-article', 'crossway'],
    ['https://sarata.com/bible/chapter/Genesis.1.html', 'sarata'],
    ['https://sermonindex.net/articles/test-article', 'sermonindex']
  ];

  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route('https://**/*', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>Source page refresh test</title></head><body><main>Source page</main></body></html>'
  }));

  for (const [url, siteId] of cases) {
    await page.goto(url, {waitUntil:'domcontentloaded'});
    const button = page.locator('#blb-suite-' + siteId + '-multiverse');
    await expect(button, url).toBeVisible();

    // The source-page collector must be recoverable on the same document when
    // the user turns redirects back ON from this site's own popup.
    await button.evaluate(element => element.remove());
    await extensionStorage.set({redirectEnabled:true});
    const activated = await extensionWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      return tabs[0]?.id == null ? false : ensureContentScriptInTab(tabs[0].id);
    });
    expect(activated, url).toBe(true);
    await expect(button, url + ' after redirect ON').toBeVisible();

    await extensionStorage.set({redirectEnabled:false});
    await expect(button, url + ' after redirect OFF').toBeVisible();
  }
});
