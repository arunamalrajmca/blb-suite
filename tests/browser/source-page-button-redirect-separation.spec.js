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

  // A lost control must be restored by the collector's own redirect-enabled
  // storage-change listener, even though the page itself is not reloaded.
  await button.evaluate(element => element.remove());
  await expect(button).toHaveCount(0);
  await extensionStorage.set({redirectEnabled:true});
  await expect(button).toBeVisible();

  await extensionStorage.set({redirectEnabled:false});
  await expect(button).toBeVisible();

  await extensionStorage.set({masterEnabled:false});
  await expect(button).toHaveCount(0);

  await extensionStorage.set({masterEnabled:true});
  await expect(button).toBeVisible();
});


test('same-tab redirect re-enable restores source-page buttons on every registered host', async ({
  page, extensionStorage
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

    // Simulate the missing control after the user turns redirects OFF, then
    // re-enable from this same site's popup. The collector's own storage
    // listener must restore the control without requiring navigation.
    await button.evaluate(element => element.remove());
    await extensionStorage.set({redirectEnabled:true});
    await expect(button, url + ' after redirect ON').toBeVisible();

    await extensionStorage.set({redirectEnabled:false});
    await expect(button, url + ' after redirect OFF').toBeVisible();
  }
});

test('source-page collector button survives a full refresh with redirects OFF and ON', async ({
  page, extensionStorage, extensionWorker, context, extensionId
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route('https://www.christianity.com/wiki/prayer/test-article.html', route =>
    route.fulfill({
      status:200,
      contentType:'text/html',
      body:'<!doctype html><html><head><title>Daily verse refresh test</title></head><body><main>Daily verse</main></body></html>'
    })
  );

  await page.goto('https://www.christianity.com/wiki/prayer/test-article.html', {waitUntil:'domcontentloaded'});
  const button = page.locator('#blb-suite-christianity-multiverse');
  await expect(button).toBeVisible();

  // The fixture must not statically inject source-page scripts. Confirm that
  // the real background runtime registration owns this host instead.
  const registration = await extensionWorker.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    const staticMatch = (manifest.content_scripts || []).some(script =>
      (script.matches || []).some(match => match.includes('christianity.com'))
    );
    const registered = await chrome.scripting.getRegisteredContentScripts();
    return {
      staticMatch,
      runtime: registered.find(script =>
        (script.matches || []).includes('https://www.christianity.com/*')
      ) || null
    };
  });
  expect(registration.staticMatch).toBe(false);
  expect(registration.runtime?.js).toContain('source-page-collector.js');
  expect(registration.runtime?.js).toContain('content.js');

  // Exercise the actual popup handler, not a direct storage write. The test
  // fixture pre-grants HTTP(S) access so the real permission request resolves
  // without a native browser prompt.
  const popup = await context.newPage();
  await popup.goto('chrome-extension://' + extensionId + '/popup.html');
  const redirectToggle = popup.locator('#redirectEnabled');
  const redirectSwitch = popup.locator('#redirectSetting .switch');
  await expect(redirectSwitch).toBeVisible();
  await expect(redirectToggle).toBeChecked();

  // Match the reported sequence: turn redirects OFF while the control remains
  // visible, then refresh the source page. The collector is independent of the
  // global redirect preference and must initialize in the new document.
  await redirectSwitch.click();
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:null})).redirectEnabled
  )).toBe(false);
  await expect(button).toBeVisible();
  await popup.close();
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(button, 'button after refresh while redirects are OFF').toBeVisible();

  // Re-enable redirects from the popup while this source page is the active
  // website tab. The collector button must remain present.
  const reenablePopup = await context.newPage();
  await reenablePopup.goto('chrome-extension://' + extensionId + '/popup.html');
  await reenablePopup.locator('#redirectSetting .switch').click();
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:false})).redirectEnabled
  )).toBe(true);
  await expect(button, 'button after redirects are re-enabled').toBeVisible();
  await reenablePopup.close();

  // Also verify that a second full navigation still initializes the button
  // when redirects are ON.
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(button, 'button after refresh while redirects are ON').toBeVisible();
});
