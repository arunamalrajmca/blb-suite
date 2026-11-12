const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');

const sourceExtensionPath = path.resolve(__dirname, '../../extension');
const testHosts = [];

function readSourcePageCollectorRegistry(extensionPath) {
  const registryPath = path.join(extensionPath, 'source-page-collector-sites.js');
  const registryGlobal = {};
  vm.runInNewContext(fs.readFileSync(registryPath, 'utf8'), {
    globalThis: registryGlobal
  }, {filename:registryPath});
  const registry = registryGlobal.BLBSourcePageCollectorSites;
  if (!registry || typeof registry !== 'object') {
    throw new Error('Could not load the production source-page collector registry');
  }
  return registry;
}

function sharedPageButtonHosts(extensionPath) {
  return Object.entries(readSourcePageCollectorRegistry(extensionPath))
    .filter(([, config]) => config && typeof config.id === 'string' && config.id)
    .map(([host, config]) => ({host, siteId:config.id}));
}

function specializedCollectorHosts(extensionPath) {
  return Object.entries(readSourcePageCollectorRegistry(extensionPath))
    .filter(([, config]) => config && config.collectorModule)
    .map(([host, config]) => ({host, collectorModule:config.collectorModule}));
}

const test = base.extend({
  extensionPath: [async ({}, use) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blb-source-page-test-'));
    const extensionPath = path.join(tempRoot, 'extension');
    try {
      fs.cpSync(sourceExtensionPath, extensionPath, {recursive:true});
      execFileSync(process.execPath, [
        path.resolve(__dirname, '../../scripts/generate-kjv-gzip-assets.cjs'),
        extensionPath
      ], {stdio:'pipe'});
      const manifestPath = path.join(extensionPath, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // Verify static content-script scope before adding test-only host grants.
      // Runtime getManifest() may normalize host patterns, so inspect the exact
      // packaged source manifest rather than conflating host_permissions with
      // content_scripts.matches.
      const staticMatches = (manifest.content_scripts || []).flatMap(script => script.matches || []);
      if (staticMatches.some(match =>
        match === '<all_urls>' || match === 'https://*/*' ||
        (match.includes('christianity.com') || match.includes('crosswalk.com'))
      )) {
        throw new Error('Christianity.com must be activated through runtime registration, not static content_scripts.matches: ' +
          JSON.stringify(staticMatches));
      }
      manifest.host_permissions = [...new Set([
        ...(manifest.host_permissions || []),
        ...testHosts,
        'http://*/*',
        'https://*/*'
      ])];
      // Keep source-page hosts out of static content_scripts.matches. This
      // spec verifies production dynamic registrations, not fixture injection.
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      await use(extensionPath);
    } finally {
      fs.rmSync(tempRoot, {recursive:true, force:true});
    }
  }, {scope:'worker'}],
  context: async ({extensionPath}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel:'chromium',
      headless:true,
      args:[
        '--headless=new',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    try { await use(context); }
    finally { await context.close(); }
  },
  extensionWorker: async ({context}, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },
  extensionId: async ({extensionWorker}, use) => {
    await use(extensionWorker.url().split('/')[2]);
  },
  extensionStorage: async ({extensionWorker}, use) => {
    await extensionWorker.evaluate(async () => {
      for (let attempt=0; attempt<100; attempt++) {
        const {masterEnabled} = await chrome.storage.local.get({masterEnabled:null});
        if (masterEnabled !== null) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Extension storage defaults were not initialized');
    });
    await use({
      set: values => extensionWorker.evaluate(data => chrome.storage.local.set(data), values),
      clear: () => extensionWorker.evaluate(() => chrome.storage.local.clear())
    });
  },
  page: async ({context}, use) => {
    const page = await context.newPage();
    try { await use(page); }
    finally { await page.close().catch(() => {}); }
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
    const registered = await chrome.scripting.getRegisteredContentScripts();
    return {
      runtime: registered.find(script =>
        (script.matches || []).includes('https://www.christianity.com/*')
      ) || null
    };
  });
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
  await page.waitForTimeout(1000);
  const offRefreshVisible = await button.isVisible().catch(() => false);
  const collectDiagnostics = async () => extensionWorker.evaluate(async url => {
    const tabs = await chrome.tabs.query({url:'https://www.christianity.com/*'});
    const tab = tabs.find(item => item.url === url) || tabs[0];
    const settings = await chrome.storage.local.get({
      masterEnabled:true, redirectEnabled:false,
      pageSelectionButtonSites:{}, doubleClickBlbSites:{}
    });
    const registrations = await chrome.scripting.getRegisteredContentScripts();
    const pattern = 'https://www.christianity.com/*';
    const permission = await chrome.permissions.contains({origins:[pattern]});
    const shouldInject = tab ? await shouldInjectContentScriptForTab(tab, settings) : false;
    const files = tab ? contentScriptFilesForTab(tab, settings) : [];
    let documentState = null;
    let injectionError = null;
    if (tab?.id != null) {
      try {
        const result = await chrome.scripting.executeScript({
          target:{tabId:tab.id},
          func:async () => {
            let suiteEnabled = null;
            try { suiteEnabled = typeof isSuiteEnabled === 'function' ? await isSuiteEnabled() : null; } catch (_) {}
            return {
              href:location.href,
              readyState:document.readyState,
              bodyPresent:!!document.body,
              suiteEnabled,
              collectorModulePresent:!!globalThis.BLBSourcePageCollectorModule,
              collectorRegistryPresent:!!globalThis.BLBSourcePageCollectorSites?.['christianity.com'],
              buttonPresent:!!document.getElementById('blb-suite-christianity-multiverse')
            };
          }
        });
        documentState = result?.[0]?.result || null;
      } catch (error) {
        injectionError = String(error?.message || error);
      }
    }
    return {
      redirectEnabled:settings.redirectEnabled,
      masterEnabled:settings.masterEnabled,
      permission,
      shouldInject,
      expectedFiles:files,
      registered:registrations.filter(item => (item.matches || []).includes(pattern)),
      tab:tab ? {id:tab.id,url:tab.url,status:tab.status} : null,
      documentState,
      injectionError
    };
  }, sourceUrl);
  const offRefreshDiagnostics = await collectDiagnostics();

  // Turn redirects ON from the same source tab context even if the OFF refresh
  // lost the button. Capture whether the normal popup path repairs that loss.
  const popupOn = await openPopupForSourceTab();
  await expect(popupOn.locator('#redirectEnabled')).not.toBeChecked();
  await popupOn.locator('#redirectSetting .switch').click();
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:false})).redirectEnabled
  )).toBe(true);
  const reenableVisible = await button.isVisible().catch(() => false);
  const reenableDiagnostics = await collectDiagnostics();
  await popupOn.close();

  await page.bringToFront();
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1000);
  const onRefreshVisible = await button.isVisible().catch(() => false);
  const onRefreshDiagnostics = await collectDiagnostics();

  expect({
    offRefreshVisible,
    reenableVisible,
    onRefreshVisible
  }, 'OFF-refresh, ON-recovery, and ON-refresh diagnostics: ' +
    JSON.stringify({offRefreshDiagnostics, reenableDiagnostics, onRefreshDiagnostics}, null, 2))
    .toEqual({
      offRefreshVisible:true,
      reenableVisible:true,
      onRefreshVisible:true
    });

  expect(offRefreshDiagnostics.registered.find(item =>
    item.id === 'blb-suite-runtime-3p3w7i'
  )?.persistAcrossSessions).toBe(true);
  expect(offRefreshDiagnostics.documentState?.collectorRegistryPresent).toBe(true);
});

test('Crosswalk source-page collector button survives full refreshes around real popup toggles', async ({
  page, extensionStorage, extensionWorker, context, extensionId
}) => {
  const sourceUrl = 'https://www.crosswalk.com/devotionals/test-article.html';
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
      body:'<!doctype html><html><head><title>Crosswalk article refresh test</title></head><body><main>Article</main></body></html>'
    })
  );

  await page.goto(sourceUrl, {waitUntil:'domcontentloaded'});
  const button = page.locator('#blb-suite-crosswalk-multiverse');
  await expect(button).toBeVisible();

  // Confirm this supported nested page is activated only through a persistent
  // runtime registration, not a test-only static content_scripts match.
  const registration = await extensionWorker.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    const registered = await chrome.scripting.getRegisteredContentScripts();
    return {
      runtime: registered.find(script =>
        (script.matches || []).includes('https://www.crosswalk.com/*')
      ) || null
    };
  });
  expect(registration.runtime?.js).toContain('source-page-collector.js');
  expect(registration.runtime?.js).toContain('content.js');

  // The test opens the actual popup document and clicks its real visible
  // control. Because Playwright opens that document as a tab, explicitly map
  // the popup's current-window tab query back to the still-active source tab.
  // This models Chrome's action-popup context: tabs.query(active,currentWindow)
  // must resolve to Crosswalk.com, never to popup.html.
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
            const sourceTabs = await nativeQuery({url:'https://www.crosswalk.com/*'});
            if (sourceTabs.length) return sourceTabs;
          }
          return nativeQuery(queryInfo);
        }
      });
      const activeTabs = await chrome.tabs.query({active:true,currentWindow:true});
      if (activeTabs.length !== 1 ||
          !String(activeTabs[0].url || '').startsWith('https://www.crosswalk.com/')) {
        throw new Error('Popup active-tab context did not resolve to the Crosswalk.com source tab');
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
  await page.waitForTimeout(1000);
  const offRefreshVisible = await button.isVisible().catch(() => false);
  const collectDiagnostics = async () => extensionWorker.evaluate(async url => {
    const tabs = await chrome.tabs.query({url:'https://www.crosswalk.com/*'});
    const tab = tabs.find(item => item.url === url) || tabs[0];
    const settings = await chrome.storage.local.get({
      masterEnabled:true, redirectEnabled:false,
      pageSelectionButtonSites:{}, doubleClickBlbSites:{}
    });
    const registrations = await chrome.scripting.getRegisteredContentScripts();
    const pattern = 'https://www.crosswalk.com/*';
    const permission = await chrome.permissions.contains({origins:[pattern]});
    const shouldInject = tab ? await shouldInjectContentScriptForTab(tab, settings) : false;
    const files = tab ? contentScriptFilesForTab(tab, settings) : [];
    let documentState = null;
    let injectionError = null;
    if (tab?.id != null) {
      try {
        const result = await chrome.scripting.executeScript({
          target:{tabId:tab.id},
          func:async () => {
            let suiteEnabled = null;
            try { suiteEnabled = typeof isSuiteEnabled === 'function' ? await isSuiteEnabled() : null; } catch (_) {}
            return {
              href:location.href,
              readyState:document.readyState,
              bodyPresent:!!document.body,
              suiteEnabled,
              collectorModulePresent:!!globalThis.BLBSourcePageCollectorModule,
              collectorRegistryPresent:!!globalThis.BLBSourcePageCollectorSites?.['crosswalk.com'],
              buttonPresent:!!document.getElementById('blb-suite-crosswalk-multiverse')
            };
          }
        });
        documentState = result?.[0]?.result || null;
      } catch (error) {
        injectionError = String(error?.message || error);
      }
    }
    return {
      redirectEnabled:settings.redirectEnabled,
      masterEnabled:settings.masterEnabled,
      permission,
      shouldInject,
      expectedFiles:files,
      registered:registrations.filter(item => (item.matches || []).includes(pattern)),
      tab:tab ? {id:tab.id,url:tab.url,status:tab.status} : null,
      documentState,
      injectionError
    };
  }, sourceUrl);
  const offRefreshDiagnostics = await collectDiagnostics();

  // Turn redirects ON from the same source tab context even if the OFF refresh
  // lost the button. Capture whether the normal popup path repairs that loss.
  const popupOn = await openPopupForSourceTab();
  await expect(popupOn.locator('#redirectEnabled')).not.toBeChecked();
  await popupOn.locator('#redirectSetting .switch').click();
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:false})).redirectEnabled
  )).toBe(true);
  const reenableVisible = await button.isVisible().catch(() => false);
  const reenableDiagnostics = await collectDiagnostics();
  await popupOn.close();

  await page.bringToFront();
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1000);
  const onRefreshVisible = await button.isVisible().catch(() => false);
  const onRefreshDiagnostics = await collectDiagnostics();

  expect({
    offRefreshVisible,
    reenableVisible,
    onRefreshVisible
  }, 'OFF-refresh, ON-recovery, and ON-refresh diagnostics: ' +
    JSON.stringify({offRefreshDiagnostics, reenableDiagnostics, onRefreshDiagnostics}, null, 2))
    .toEqual({
      offRefreshVisible:true,
      reenableVisible:true,
      onRefreshVisible:true
    });

  expect(offRefreshDiagnostics.registered.find(item =>
    (item.matches || []).includes('https://www.crosswalk.com/*')
  )?.persistAcrossSessions).toBe(true);
  expect(offRefreshDiagnostics.documentState?.collectorRegistryPresent).toBe(true);
});


test('Christianity.com and Crosswalk.com exclude homepages while enabling nested-page buttons', async ({
  page, extensionStorage
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });

  const cases = [
    {
      home:'https://www.christianity.com/',
      article:'https://www.christianity.com/wiki/prayer/test-article.html',
      selector:'#blb-suite-christianity-multiverse'
    },
    {
      home:'https://www.crosswalk.com/',
      article:'https://www.crosswalk.com/devotionals/test-article.html',
      selector:'#blb-suite-crosswalk-multiverse'
    }
  ];

  for (const fixture of cases) {
    await page.route(fixture.home, route => route.fulfill({
      status:200,
      contentType:'text/html',
      body:'<!doctype html><html><head><title>Homepage exclusion fixture</title></head><body><main>Homepage</main></body></html>'
    }));
    await page.route(fixture.article, route => route.fulfill({
      status:200,
      contentType:'text/html',
      body:'<!doctype html><html><head><title>Nested article fixture</title></head><body><main>Article</main></body></html>'
    }));

    await page.goto(fixture.home, {waitUntil:'domcontentloaded'});
    await expect(page.locator(fixture.selector), fixture.home).toHaveCount(0);

    await page.goto(fixture.article, {waitUntil:'domcontentloaded'});
    await expect(page.locator(fixture.selector), fixture.article)
      .toHaveText('Open Bible References in BLB');
  }
});


test('every shared-registry page-button host shows the exact button on content pages and excludes homepages', async ({
  page, extensionStorage, extensionPath
}) => {
  const cases = sharedPageButtonHosts(extensionPath);
  expect(cases.length, 'the shared page-button registry must not be empty').toBeGreaterThan(0);

  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route('https://**/*', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>Page-button host fixture</title></head><body><main>Fixture content</main></body></html>'
  }));

  for (const {host, siteId} of cases) {
    const homepage = 'https://' + host + '/';
    const contentPage = 'https://' + host + '/__blb-suite-regression__/content';
    const button = page.locator('#blb-suite-' + siteId + '-multiverse');
    await page.goto(homepage, {waitUntil:'domcontentloaded'});
    await expect(button, homepage + ' must not show the page button').toHaveCount(0);

    await page.goto(contentPage, {waitUntil:'domcontentloaded'});
    await expect(button, contentPage + ' must show the expected page button')
      .toHaveText('Open Bible References in BLB');
  }
});

test('every specialized source-page collector has dedicated button-rendering regression coverage', async ({
  extensionPath
}) => {
  const specialized = specializedCollectorHosts(extensionPath);
  const covered = new Set(['thekingsbible.com', 'webstersdictionary1828.com']);
  const uncovered = specialized.map(({host}) => host).filter(host => !covered.has(host));
  const stale = [...covered].filter(host => !specialized.some(item => item.host === host));
  expect({uncovered, stale}, 'update dedicated collector tests when specialized registry entries change')
    .toEqual({uncovered:[], stale:[]});
});

test("The King's Bible dictionary and concordance pages render the BLB references button", async ({
  page, extensionStorage
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route('https://www.thekingsbible.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>The King\'s Bible fixture</title></head><body><main><a class="bible" href="/Bible/1/1">Genesis 1:1</a></main></body></html>'
  }));

  for (const path of ['/dictionary/Faith', '/concordance/Creation']) {
    await page.goto('https://www.thekingsbible.com' + path, {waitUntil:'domcontentloaded'});
    const button = page.locator('#blb-suite-kingsbible-multiverse');
    await expect(button, path).toHaveText('Open Bible References in BLB');
  }
});


test("Webster's 1828 dictionary entries render the exact BLB references button", async ({
  page, extensionStorage
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route('https://webstersdictionary1828.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>Webster entry fixture</title></head><body><main><h1>Faith</h1></main></body></html>'
  }));
  await page.goto('https://webstersdictionary1828.com/dictionary/Faith', {waitUntil:'domcontentloaded'});
  await expect(page.locator('#blb-suite-webster-multiverse'))
    .toHaveText('Open Bible References in BLB');
});

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
      hasRedirectBundle:true,
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
  page, extensionStorage, extensionPath
}) => {
  const cases = sharedPageButtonHosts(extensionPath)
    .map(({host, siteId}) => ({
      url:'https://' + host + '/__blb-suite-regression__/content',
      siteId
    }));

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

  for (const {url, siteId} of cases) {
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