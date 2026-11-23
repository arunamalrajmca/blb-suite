const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');

const sourceExtensionPath = path.resolve(__dirname, '../../extension');

async function installMasterToggleRegistrationDiagnostics(extensionWorker) {
  return extensionWorker.evaluate(() => {
    const targetPattern = 'https://christianity.com/*';
    const targetId = runtimeContentScriptIdForPattern(targetPattern);
    const state = {startedAt:Date.now(), events:[], nextId:1};
    const record = (type, details = {}) => {
      state.events.push({at:Date.now(), elapsedMs:Date.now()-state.startedAt, type, ...details});
      if (state.events.length > 1200) state.events.splice(0, state.events.length-1200);
    };
    globalThis.__BLB_MASTER_TOGGLE_DIAGNOSTICS__ = state;
    const safe = value => { try { return JSON.parse(JSON.stringify(value)); } catch (_) { return String(value); } };
    const wrapApi = (owner, name, summarizeArgs, summarizeResult) => {
      const original = owner?.[name];
      if (typeof original !== 'function') return;
      const wrapped = async function(...args) {
        const details = summarizeArgs(args);
        const id = state.nextId++;
        const startedAt = Date.now();
        record(name + ':start', {id, ...details});
        try {
          const result = await original.apply(this, args);
          record(name + ':end', {id, durationMs:Date.now()-startedAt, ...summarizeResult(result)});
          return result;
        } catch (error) {
          record(name + ':error', {id,durationMs:Date.now()-startedAt,errorName:error?.name || '',
            errorMessage:error?.message || String(error),errorStack:error?.stack || ''});
          throw error;
        }
      };
      try {
        owner[name] = wrapped;
        if (owner[name] !== wrapped) record('diagnostics:patch-unavailable',{target:'api.'+name});
      } catch (error) {
        record('diagnostics:patch-error',{target:'api.'+name,error:String(error)});
      }
    };
    wrapApi(chrome.scripting, 'getRegisteredContentScripts', args => ({ids:args[0]?.ids || null}),
      result => ({ids:(result || []).filter(item => (item.matches || []).includes(targetPattern) ||
        [targetId,targetId+'-main-world'].includes(item.id)).map(item => item.id),count:(result || []).length}));
    wrapApi(chrome.scripting, 'registerContentScripts', args => ({scripts:(args[0] || []).map(item => ({
      id:item.id,matches:item.matches,js:item.js,world:item.world || 'ISOLATED',
      persistAcrossSessions:item.persistAcrossSessions
    }))}), result => ({result:safe(result)}));
    wrapApi(chrome.scripting, 'updateContentScripts', args => ({scripts:(args[0] || []).map(item => ({
      id:item.id,matches:item.matches,js:item.js,world:item.world
    }))}), result => ({result:safe(result)}));
    wrapApi(chrome.scripting, 'unregisterContentScripts', args => ({ids:args[0]?.ids || null}),
      result => ({result:safe(result)}));
    wrapApi(chrome.permissions, 'contains', args => ({origins:args[0]?.origins || null}),
      result => ({granted:result}));

    const wrappedFunctions = [
      'reconcileRuntimeContentScriptRegistrations','reconcileRuntimeContentScriptRegistrationsNow',
      'injectConfiguredTabsAfterExtensionUpdate','ensureContentScriptInTab','ensureContentScriptInTabWithRetry',
      'ensureRuntimeContentScriptRegistered','registerRuntimeContentScriptForPattern',
      'unregisterRuntimeContentScriptForPattern'
    ];
    const availableFunctions = [];
    for (const name of wrappedFunctions) {
      const original = globalThis[name];
      if (typeof original !== 'function') continue;
      availableFunctions.push(name);
      const wrapped = async function(...args) {
        const id = state.nextId++;
        const startedAt = Date.now();
        record(name + ':start', {id,args:safe(args)});
        try {
          const result = await original.apply(this,args);
          record(name + ':end', {id,durationMs:Date.now()-startedAt,result:safe(result)});
          return result;
        } catch (error) {
          record(name + ':error', {id,durationMs:Date.now()-startedAt,errorName:error?.name || '',
            errorMessage:error?.message || String(error),errorStack:error?.stack || ''});
          throw error;
        }
      };
      try {
        globalThis[name] = wrapped;
        if (globalThis[name] !== wrapped) record('diagnostics:patch-unavailable',{target:name});
      } catch (error) {
        record('diagnostics:patch-error',{target:name,error:String(error)});
      }
    }
    chrome.storage.onChanged.addListener((changes,area) => {
      if (area !== 'local') return;
      const relevant = {};
      for (const key of ['masterEnabled','redirectEnabled','pageSelectionButtonSites','doubleClickBlbSites']) {
        if (changes[key]) relevant[key] = {oldValue:safe(changes[key].oldValue),newValue:safe(changes[key].newValue)};
      }
      if (Object.keys(relevant).length) record('storage:onChanged',{changes:relevant});
    });
    try { chrome.runtime.onSuspend.addListener(() => record('runtime:onSuspend')); } catch (_) {}
    try { chrome.runtime.onSuspendCanceled.addListener(() => record('runtime:onSuspendCanceled')); } catch (_) {}
    for (const level of ['warn','error']) {
      const original = console[level]?.bind(console);
      if (original) {
        const wrapped = (...args) => {
          record('console:'+level,{messages:args.map(value=>String(value)).slice(0,5)});
          return original(...args);
        };
        try { console[level] = wrapped; } catch (_) {}
      }
    }
    record('diagnostics:installed',{targetPattern,targetId,availableFunctions});
    return {installed:true,targetPattern,targetId,availableFunctions};
  });
}

async function readMasterToggleRegistrationDiagnostics(extensionWorker, workerEvents = []) {
  try {
    return await extensionWorker.evaluate(async () => {
      const state = globalThis.__BLB_MASTER_TOGGLE_DIAGNOSTICS__;
      const settings = await chrome.storage.local.get({
        masterEnabled:null,redirectEnabled:null,pageSelectionButtonSites:{},doubleClickBlbSites:{}
      });
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      const tabs = await chrome.tabs.query({url:'https://christianity.com/*'});
      return {
        workerAvailable:true,settings,
        registrations:scripts.filter(item => (item.matches || []).includes('https://christianity.com/*') ||
          String(item.id || '').includes('3p3w7i')).map(item => ({
          id:item.id,matches:item.matches,js:item.js,world:item.world || 'ISOLATED',
          persistAcrossSessions:item.persistAcrossSessions
        })),
        tabs:tabs.map(tab=>({id:tab.id,url:tab.url,status:tab.status,pendingUrl:tab.pendingUrl || null})),
        diagnosticsInstalled:!!state,diagnosticEvents:state?.events || []
      };
    });
  } catch (error) {
    return {workerAvailable:false,workerReadError:String(error?.message || error),workerEvents};
  }
}

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
    .map(([host, config]) => ({
      host,
      siteId:config.id,
      mainWorldClickGuard:config.mainWorldClickGuard === true
    }));
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
        const {masterEnabled, redirectEnabled} = await chrome.storage.local.get({
          masterEnabled:null,
          redirectEnabled:null
        });
        if (masterEnabled !== null && redirectEnabled !== null) return;
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
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:null})).redirectEnabled
  )).toBe(true);
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
    // Install the action-popup tab-context shim before popup.js initializes.
    // Patching after navigation lets getState() read popup.html as the active
    // tab and can leave the initial controls rendered from the wrong context.
    await popup.addInitScript(hostPattern => {
      const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, 'query', {
        configurable:true,
        value:async queryInfo => {
          if (queryInfo?.active === true && queryInfo?.currentWindow === true) {
            const sourceTabs = await nativeQuery({url:hostPattern});
            if (sourceTabs.length) return sourceTabs;
          }
          return nativeQuery(queryInfo);
        }
      });
    }, 'https://www.christianity.com/*');
    await popup.goto('chrome-extension://' + extensionId + '/popup.html');
    await popup.evaluate(async () => {
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
    // Install the action-popup tab-context shim before popup.js initializes.
    // Patching after navigation lets getState() read popup.html as the active
    // tab and can leave the initial controls rendered from the wrong context.
    await popup.addInitScript(hostPattern => {
      const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, 'query', {
        configurable:true,
        value:async queryInfo => {
          if (queryInfo?.active === true && queryInfo?.currentWindow === true) {
            const sourceTabs = await nativeQuery({url:hostPattern});
            if (sourceTabs.length) return sourceTabs;
          }
          return nativeQuery(queryInfo);
        }
      });
    }, 'https://www.crosswalk.com/*');
    await popup.goto('chrome-extension://' + extensionId + '/popup.html');
    await popup.evaluate(async () => {
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
  page, extensionStorage, extensionWorker
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

    const originPattern = new URL(fixture.home).origin + '/*';
    await expect.poll(() => extensionWorker.evaluate(async pattern => {
      const id = runtimeContentScriptIdForPattern(pattern);
      const [registration] = await chrome.scripting.getRegisteredContentScripts({ids:[id]});
      return Boolean(registration &&
        registration.matches?.includes(pattern) &&
        registration.js?.includes('content.js') &&
        registration.js?.includes('source-page-collector-sites.js'));
    }, originPattern)).toBe(true);

    await page.goto(fixture.article, {waitUntil:'domcontentloaded'});
    await expect(page.locator(fixture.selector), fixture.article)
      .toHaveText('Open Bible References in BLB');
  }
});


test('every shared-registry page-button host shows the exact button on content pages and excludes homepages', async ({
  page, extensionStorage, extensionPath, extensionWorker
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

    const originPattern = new URL(homepage).origin + '/*';
    await expect.poll(() => extensionWorker.evaluate(async pattern => {
      const id = runtimeContentScriptIdForPattern(pattern);
      const [registration] = await chrome.scripting.getRegisteredContentScripts({ids:[id]});
      return Boolean(registration &&
        registration.matches?.includes(pattern) &&
        registration.js?.includes('content.js') &&
        registration.js?.includes('source-page-collector-sites.js'));
    }, originPattern)).toBe(true);

    await page.goto(contentPage, {waitUntil:'domcontentloaded'});
    await expect(button, contentPage + ' must show the expected page button')
      .toHaveText('Open Bible References in BLB');
  }
});

test('BibleProject common homepage aliases remain excluded while nested pages show the button', async ({
  page, extensionStorage
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route('https://bibleproject.com/**',route => route.fulfill({
    status:200,
    contentType:'text/html; charset=utf-8',
    body:'<!doctype html><html><head><title>BibleProject homepage alias fixture</title></head><body><main>Content</main></body></html>'
  }));
  const button=page.locator('#blb-suite-bibleproject-multiverse');
  for (const path of ['/','/index','/index.html','/index.htm','/index.php','/index.asp','/index.aspx','/home','/homepage','/default','/default.aspx','/default.html','/default.php','/default.asp']) {
    const url='https://bibleproject.com'+path;
    await page.goto(url,{waitUntil:'domcontentloaded'});
    await expect(button,url+' must never display the collection button').toHaveCount(0);
  }
  await page.goto('https://bibleproject.com/articles/creation/',{waitUntil:'domcontentloaded'});
  await expect(button).toHaveText('Open Bible References in BLB');
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
  page, extensionStorage, extensionPath, extensionWorker
}) => {
  const cases = sharedPageButtonHosts(extensionPath)
    .map(({host, siteId, mainWorldClickGuard}) => ({
      url:'https://' + (host === 'christianity.com' ? 'www.' : '') + host + '/__blb-suite-regression__/content',
      siteId,
      mainWorldClickGuard
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

  for (const {url, siteId, mainWorldClickGuard} of cases) {
    const homepage = new URL(url);
    homepage.pathname = '/';
    homepage.search = '';
    homepage.hash = '';
    const button = page.locator('#blb-suite-' + siteId + '-multiverse');

    // Visit the host homepage first so its runtime content-script registration
    // is established before testing same-tab behavior on a nested content page.
    // The homepage must remain excluded from page-button rendering.
    await page.goto(homepage.toString(), {waitUntil:'domcontentloaded'});
    await expect(button, homepage.toString() + ' homepage exclusion').toHaveCount(0);

    // Do not let the nested-page navigation race the asynchronous dynamic
    // registration created by the homepage's completed navigation. The
    // behavior under test is same-tab feature refresh after registration,
    // not whether two immediate navigations happen to overlap registration.
    const originPattern = homepage.origin + '/*';
    await expect.poll(() => extensionWorker.evaluate(async pattern => {
      const id = runtimeContentScriptIdForPattern(pattern);
      const [registration] = await chrome.scripting.getRegisteredContentScripts({ids:[id]});
      return Boolean(registration &&
        registration.matches?.includes(pattern) &&
        registration.js?.includes('content.js') &&
        registration.js?.includes('source-page-collector-sites.js'));
    }, originPattern)).toBe(true);

    // The registry flag controls a second, persistent MAIN-world registration;
    // it is independent of the isolated collector bundle and is intentionally
    // absent for ordinary collector hosts. Poll separately because the isolated
    // registration is created first and the MAIN-world registration follows it.
    await expect.poll(() => extensionWorker.evaluate(async pattern => {
      const id = runtimeContentScriptIdForPattern(pattern);
      const scripts = await chrome.scripting.getRegisteredContentScripts({
        ids:[id + '-main-world']
      });
      return scripts.some(script => script.id === id + '-main-world');
    }, originPattern), {timeout:10000}).toBe(mainWorldClickGuard);

    await expect.poll(() => extensionWorker.evaluate(async pattern => {
      const [tab] = await chrome.tabs.query({url:pattern});
      if (tab?.id == null) return false;
      const [result] = await chrome.scripting.executeScript({
        target:{tabId:tab.id},
        world:'MAIN',
        func:() => globalThis.__blbSourcePassageClickGuardInstalled === true
      });
      return result?.result === true;
    }, originPattern), {timeout:10000}).toBe(mainWorldClickGuard);

    const guardState = await extensionWorker.evaluate(async pattern => {
      const id = runtimeContentScriptIdForPattern(pattern);
      const scripts = await chrome.scripting.getRegisteredContentScripts({
        ids:[id, id + '-main-world']
      });
      const isolated = scripts.find(script => script.id === id) || null;
      const mainWorld = scripts.find(script => script.id === id + '-main-world') || null;
      const [tab] = await chrome.tabs.query({url:pattern});
      let mainWorldMarker = false;
      if (tab?.id != null) {
        const [result] = await chrome.scripting.executeScript({
          target:{tabId:tab.id},
          world:'MAIN',
          func:() => globalThis.__blbSourcePassageClickGuardInstalled === true
        });
        mainWorldMarker = result?.result === true;
      }
      return {isolated, mainWorld, mainWorldMarker};
    }, originPattern);
    expect(guardState.isolated?.js).toContain('content.js');
    expect(Boolean(guardState.mainWorld), originPattern).toBe(mainWorldClickGuard);
    expect(guardState.mainWorldMarker, originPattern).toBe(mainWorldClickGuard);
    if (mainWorldClickGuard) {
      expect(guardState.mainWorld).toMatchObject({
        matches:[originPattern],
        js:['source-page-collector-sites.js','redirect-christianity-main-world.js'],
        runAt:'document_start',
        world:'MAIN',
        persistAcrossSessions:true
      });
    }

    await page.goto(url, {waitUntil:'domcontentloaded'});
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
test('source Bible redirect activates on the same page when the Suite master switch is re-enabled', async ({
  page, extensionStorage, extensionWorker
}) => {
  const sourceUrl = 'https://www.christianity.com/bible/esv/john/3-16';
  const destinationUrl = 'https://www.blueletterbible.org/kjv/jhn/3/16/';

  await extensionStorage.set({
    masterEnabled:false,
    redirectEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });
  await page.route('https://www.christianity.com/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>Christianity passage</title></head><body><main>John 3:16</main></body></html>'
  }));
  await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>BLB destination</title></head><body><main>John 3:16 KJV</main></body></html>'
  }));

  await page.goto(sourceUrl, {waitUntil:'domcontentloaded'});
  // Dynamic source-page injection is reconciled after navigation completes.
  // Wait for that registration/injection work before toggling the Suite.
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(sourceUrl);

  const before = await extensionWorker.evaluate(async () =>
    chrome.tabs.query({url:'https://www.blueletterbible.org/*'})
  );
  expect(before).toHaveLength(0);

  await extensionStorage.set({masterEnabled:true});
  await expect.poll(async () => {
    const tabs = await extensionWorker.evaluate(async () =>
      chrome.tabs.query({url:'https://www.blueletterbible.org/*'})
    );
    return tabs.some(tab => (tab.url || tab.pendingUrl || '') === destinationUrl);
  }, {timeout:10000}).toBe(true);
  await expect(page).toHaveURL(sourceUrl);
});

test('BibleProject homepage stays excluded while nested pages expose Open Bible References in BLB', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:false,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });

  const fixtures = [
    {
      url:'https://bibleproject.com/',
      title:'BibleProject homepage',
      body:'<main><a href="/explore/video/john-3-16/">John 3:16</a></main>'
    },
    {
      url:'https://bibleproject.com/explore/video/john-3-16/',
      title:'BibleProject article',
      body:'<main><a href="https://www.blueletterbible.org/kjv/jhn/3/16/">John 3:16</a></main>'
    }
  ];

  for (const fixture of fixtures) {
    await page.route(fixture.url, route => route.fulfill({
      status:200,
      contentType:'text/html; charset=utf-8',
      body:'<!doctype html><html><head><title>' + fixture.title +
        '</title></head><body>' + fixture.body + '</body></html>'
    }));
    await page.goto(fixture.url, {waitUntil:'domcontentloaded'});
    const button=page.locator('#blb-suite-bibleproject-multiverse');
    if (new URL(fixture.url).pathname === '/') {
      await expect(button).toHaveCount(0);
    } else {
      await expect(button).toHaveText('Open Bible References in BLB');
    }
  }

  const registration = await extensionWorker.evaluate(async () => {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    return scripts.find(script =>
      (script.matches || []).includes('https://bibleproject.com/*')
    ) || null;
  });
  expect(registration?.js).toContain('source-page-collector.js');
  expect(registration?.js).toContain('content.js');
});


test('Suite master opt-out removes both registered worlds for guarded source hosts and re-enable restores them', async ({
  page, extensionStorage, extensionWorker, context
}, testInfo) => {
  const sourceUrl = 'https://christianity.com/__blb-suite-regression__/master-toggle';
  const originPattern = 'https://christianity.com/*';
  const workerEvents = [];
  const observeWorker = worker => {
    workerEvents.push({type:'serviceworker-created',at:Date.now(),url:worker.url()});
    try { worker.on('close',()=>workerEvents.push({type:'serviceworker-closed',at:Date.now(),url:worker.url()})); } catch (_) {}
    try { worker.on('console',message=>workerEvents.push({
      type:'serviceworker-console',at:Date.now(),level:message.type(),text:message.text()
    })); } catch (_) {}
  };
  observeWorker(extensionWorker);
  context.on('serviceworker',observeWorker);
  const installed = await installMasterToggleRegistrationDiagnostics(extensionWorker);

  const attachDiagnostics = async label => {
    const diagnostics = await readMasterToggleRegistrationDiagnostics(extensionWorker,workerEvents);
    diagnostics.workerEvents = workerEvents;
    diagnostics.label = label;
    await testInfo.attach('master-toggle-registration-'+label+'.json',{
      body:Buffer.from(JSON.stringify(diagnostics,null,2)),contentType:'application/json'
    });
    return diagnostics;
  };
  const expectRegistrations = async (expected,label) => {
    try {
      await expect.poll(async () => extensionWorker.evaluate(async pattern => {
        const id = runtimeContentScriptIdForPattern(pattern);
        const scripts = await chrome.scripting.getRegisteredContentScripts({ids:[id,id+'-main-world']});
        return {
          isolated:scripts.some(script=>script.id===id),
          mainWorld:scripts.some(script=>script.id===id+'-main-world')
        };
      },originPattern),{timeout:15000}).toEqual(expected);
    } catch (error) {
      const diagnostics = await attachDiagnostics(label+'-failure');
      throw new Error(error.message+'\nMASTER-TOGGLE DIAGNOSTICS:\n'+JSON.stringify(diagnostics,null,2));
    }
  };

  await extensionStorage.set({
    masterEnabled:true,redirectEnabled:false,pageSelectionButtonSites:{},doubleClickBlbSites:{}
  });
  await page.route('https://christianity.com/**',route=>route.fulfill({
    status:200,contentType:'text/html',
    body:'<!doctype html><html><head><title>Guard registration lifecycle</title></head><body><main>Article</main></body></html>'
  }));
  await page.goto(sourceUrl,{waitUntil:'domcontentloaded'});
  await expectRegistrations({isolated:true,mainWorld:true},'initial-on');

  await extensionStorage.set({masterEnabled:false});
  await expectRegistrations({isolated:false,mainWorld:false},'master-off');

  await extensionStorage.set({masterEnabled:true});
  await expectRegistrations({isolated:true,mainWorld:true},'master-reenable');

  await attachDiagnostics('success');
  const finalDiagnostics = await readMasterToggleRegistrationDiagnostics(extensionWorker,workerEvents);
  console.log('BLB_MASTER_TOGGLE_TRACE '+JSON.stringify({
    installed,workerEvents,eventCount:finalDiagnostics.diagnosticEvents?.length || 0,
    settings:finalDiagnostics.settings,registrations:finalDiagnostics.registrations
  }));
});

test('SagacityWeb and Rediscover Bible reference clicks reuse the existing BLB destination tab', async ({
  page, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({
    masterEnabled:true,
    redirectEnabled:true,
    pageSelectionButtonSites:{},
    doubleClickBlbSites:{}
  });

  for (const host of ['sagacityweb.com','rediscover.bible']) {
    const destinationUrl = host === 'rediscover.bible'
      ? 'https://www.blueletterbible.org/search/preSearch.cfm?Criteria=Acts+1%3A1-7%3A59&t=ESV'
      : 'https://www.blueletterbible.org/kjv/jhn/3/16/';
    const referenceLabel = host === 'rediscover.bible' ? 'Acts 1:1–7:59' : 'John 3:16';
    const homepage = 'https://' + host + '/';
    const article = host === 'sagacityweb.com'
      ? 'https://sagacityweb.com/the-digital-harlot-resisting-the-seduction-of-modern-babylon/'
      : 'https://rediscover.bible/acts_intro.html';

    await page.route('https://' + host + '/**', route => route.fulfill({
      status:200,
      contentType:'text/html; charset=utf-8',
      body:'<!doctype html><html><head><title>Source reference fixture</title></head><body>' +
        '<main><a id="bible-reference" target="_blank" href="' + destinationUrl +
        '">' + referenceLabel + '</a></main></body></html>'
    }));
    await page.route('https://www.blueletterbible.org/**', route => route.fulfill({
      status:200,
      contentType:'text/html; charset=utf-8',
      body:'<!doctype html><html><head><title>BLB destination</title></head><body>John 3:16 KJV</body></html>'
    }));

    await page.goto(homepage, {waitUntil:'domcontentloaded'});
    const originPattern = 'https://' + host + '/*';
    await expect.poll(() => extensionWorker.evaluate(async pattern => {
      const id = runtimeContentScriptIdForPattern(pattern);
      const [isolated, mainWorld] = await Promise.all([
        chrome.scripting.getRegisteredContentScripts({ids:[id]}),
        chrome.scripting.getRegisteredContentScripts({ids:[id + '-main-world']})
      ]);
      return Boolean(isolated[0]?.js?.includes('content.js') &&
        mainWorld[0]?.world === 'MAIN');
    }, originPattern), {timeout:15000}).toBe(true);

    await page.goto(article, {waitUntil:'domcontentloaded'});
    await expect(page.locator('#bible-reference')).toBeVisible();
    await expect.poll(() => page.evaluate(() =>
      globalThis.__blbSourcePassageClickGuardInstalled === true
    ), {timeout:10000}).toBe(true);

    await page.locator('#bible-reference').click();
    await expect.poll(() => extensionWorker.evaluate(async target => {
      const tabs = await chrome.tabs.query({url:'https://www.blueletterbible.org/*'});
      return tabs.filter(tab => tab.url === target || tab.pendingUrl === target).length;
    }, destinationUrl)).toBe(1);

    const firstDestinationTab = await extensionWorker.evaluate(async target => {
      const tabs = await chrome.tabs.query({url:'https://www.blueletterbible.org/*'});
      return tabs.find(tab => tab.url === target || tab.pendingUrl === target)?.id ?? null;
    }, destinationUrl);
    expect(firstDestinationTab).not.toBeNull();

    await page.locator('#bible-reference').click();
    await expect.poll(() => extensionWorker.evaluate(async target => {
      const tabs = await chrome.tabs.query({url:'https://www.blueletterbible.org/*'});
      const matches = tabs.filter(tab => (tab.url || tab.pendingUrl || '') === target);
      const [active] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      return {count:matches.length, activeId:active?.id ?? null, matchId:matches[0]?.id ?? null};
    }, destinationUrl)).toEqual({
      count:1,
      activeId:firstDestinationTab,
      matchId:firstDestinationTab
    });

    await expect(page).toHaveURL(article);
  }
});

