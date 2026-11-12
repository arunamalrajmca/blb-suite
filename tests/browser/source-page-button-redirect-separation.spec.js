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

test('source-page collector button survives full refreshes around real popup toggles', async ({
  page, extensionStorage, extensionWorker, context, extensionId
}) => {
  const sourceUrl = 'https://www.christianity.com/wiki/prayer/test-article.html';
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route(sourceUrl, route =>
    route.fulfill({
      status:200,
      contentType:'text/html',
      body:'<!doctype html><html><head><title>Christianity article refresh test</title></head><body><main>Article</main></body></html>'
    })
  );

  await page.goto(sourceUrl, {waitUntil:'domcontentloaded'});
  const button = page.locator('#blb-suite-christianity-multiverse');
  await expect(button).toBeVisible();

  // Confirm this supported nested page is activated only through a persistent
  // runtime registration, not a test-only static content_scripts match.
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

  // The test opens the actual popup document and clicks its real visible
  // control. Because Playwright opens that document as a tab, explicitly map
  // the popup's current-window tab query back to the still-active source tab.
  // This models Chrome's action-popup context: tabs.query(active,currentWindow)
  // must resolve to Christianity.com, never to popup.html.
  const openPopupForSourceTab = async () => {
    await page.bringToFront();
    const popup = await context.newPage();
    await popup.goto('chrome-extension://' + extensionId + '/popup.html');
    await popup.evaluate(async () => {
      const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, 'query', {
        configurable:true,
        value:async queryInfo => {
          if (queryInfo?.active === true && queryInfo?.currentWindow === true) {
            const sourceTabs = await nativeQuery({url:'https://www.christianity.com/*'});
            if (sourceTabs.length) return sourceTabs;
          }
          return nativeQuery(queryInfo);
        }
      });
      const activeTabs = await chrome.tabs.query({active:true,currentWindow:true});
      if (activeTabs.length !== 1 ||
          !String(activeTabs[0].url || '').startsWith('https://www.christianity.com/')) {
        throw new Error('Popup active-tab context did not resolve to the Christianity.com source tab');
      }
    });
    return popup;
  };

  // Turn redirects OFF using the popup control, then refresh the nested page.
  const popupOff = await openPopupForSourceTab();
  await expect(popupOff.locator('#redirectEnabled')).toBeChecked();
  await popupOff.locator('#redirectSetting .switch').click();
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:null})).redirectEnabled
  )).toBe(false);
  await popupOff.close();

  await page.bringToFront();
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(button, 'button after refresh while redirects are OFF').toBeVisible();

  // Turn redirects ON from the same source tab context. This also exercises
  // setRedirect(true)'s explicit blbSuiteEnsureContentScript tab handoff.
  const popupOn = await openPopupForSourceTab();
  await expect(popupOn.locator('#redirectEnabled')).not.toBeChecked();
  await popupOn.locator('#redirectSetting .switch').click();
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:false})).redirectEnabled
  )).toBe(true);
  await expect(button, 'button after redirects are re-enabled').toBeVisible();
  await popupOn.close();

  await page.bringToFront();
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(button, 'button after refresh while redirects are ON').toBeVisible();
});
