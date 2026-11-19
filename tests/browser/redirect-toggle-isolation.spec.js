const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popup = fs.readFileSync(path.resolve(__dirname, '../../extension/popup.js'), 'utf8');

function runPopupState({origins = [], pagePrefs = {}, doublePrefs = {}} = {}) {
  const start = popup.indexOf('async function getState() {');
  const end = popup.indexOf('\nconst extensionVersion', start);
  if (start < 0 || end < 0) throw new Error('Could not extract getState from extension/popup.js');
  const context = {
    URL,
    BLB_HOSTNAME: 'blueletterbible.org',
    getSiteKey: () => 'sagacityweb.com',
    isSensitiveSiteUrl: () => false,
    deriveSiteCaption: () => 'sagacityweb.com',
    chrome: {
      tabs: { query: async () => [{url:'https://sagacityweb.com/', title:'Sagacity'}] },
      storage: { local: { get: async () => ({
        masterEnabled:true,
        pageSelectionButtonSites:pagePrefs,
        doubleClickBlbSites:doublePrefs,
        redirectEnabled:false
      }) } },
      permissions: {
        contains: async ({origins:requested}) => requested.every(origin =>
          origins.includes(origin) || origins.includes('https://*/*') || origins.includes('http://*/*')
        ),
        getAll: async () => ({origins})
      }
    }
  };
  vm.runInNewContext(`${popup.slice(start, end)}\nthis.getState = getState;`, context);
  return context.getState();
}

test.describe('site feature fail-closed guards', () => {
  test('global redirects default OFF when the saved setting is absent', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
    expect(source).toContain('let theKingsBibleRedirectEnabled = false;');
    expect(source).toContain('let sourceBibleRedirectEnabled = false;');
    expect(source).toContain('chrome.storage.local.get({redirectEnabled:false})');
  });

  test('Double-click disables itself when site settings cannot be read', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
    const start = source.indexOf('async function refreshDoubleClickBlb() {');
    const end = source.indexOf('\nfunction ensureDoubleClickSettingsReady()', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain('catch (_)');
    expect(handler).toContain('doubleClickBlbEnabled = false;');
    expect(handler).toContain('disableDoubleClickBlb();');
  });

  test('Show on BLB disables its monitoring when site settings cannot be read', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../extension/blb-page-selection-button.js'), 'utf8');
    const start = source.indexOf('async function refreshBlbPageSelectionButton() {');
    const end = source.indexOf('\n    if (!isBlbPageButtonExcludedSite()', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain('catch (_)');
    expect(handler).toContain('disableBlbPageButtonMonitoring();');
  });
});

test.describe('independent site feature permissions and global redirects', () => {
  test('wildcard redirect grants do not enable site features without explicit preferences', async () => {
    const state = await runPopupState({origins:['http://*/*', 'https://*/*']});
    expect(state.pageButton).toBe(false);
    expect(state.doubleClick).toBe(false);
  });

  test('wildcard-only redirect grants do not authorize explicitly enabled site features', async () => {
    const state = await runPopupState({
      origins:['http://*/*', 'https://*/*'],
      pagePrefs:{'sagacityweb.com':true},
      doublePrefs:{'sagacityweb.com':true}
    });
    expect(state.pageButton).toBe(false);
    expect(state.doubleClick).toBe(false);
  });

  test('explicit site preferences enable their features when exact host access is granted', async () => {
    const state = await runPopupState({
      origins:['https://sagacityweb.com/*'],
      pagePrefs:{'sagacityweb.com':true},
      doublePrefs:{'sagacityweb.com':true}
    });
    expect(state.pageButton).toBe(true);
    expect(state.doubleClick).toBe(true);
  });

  test('each site feature toggle routes through the independent permission handler', () => {
    const start = popup.indexOf('async function setIndependentSiteFeature(feature, on) {');
    const end = popup.indexOf('\nasync function handlePageButtonToggle(on)', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = popup.slice(start, end);
    expect(handler).toContain("setPageButton(true, pinned?.requestId)");
    expect(handler).toContain("setDoubleClick(true, pinned?.requestId)");
    expect(handler).toContain("pinSiteFeatureChoice(feature)");

    const pageHandlerStart = popup.indexOf('async function handlePageButtonToggle(on) {');
    const doubleHandlerStart = popup.indexOf('async function handleDoubleClickToggle(on) {');
    const listenerStart = popup.indexOf("\ndocument.getElementById('pageButton').addEventListener", doubleHandlerStart);
    expect(pageHandlerStart).toBeGreaterThanOrEqual(0);
    expect(doubleHandlerStart).toBeGreaterThan(pageHandlerStart);
    expect(listenerStart).toBeGreaterThan(doubleHandlerStart);
    expect(popup.slice(pageHandlerStart, doubleHandlerStart)).toContain("setIndependentSiteFeature('pageButton', on)");
    expect(popup.slice(doubleHandlerStart, listenerStart)).toContain("setIndependentSiteFeature('doubleClick', on)");
  });

  test('site permission is requested synchronously after pinning the preference', () => {
    const start = popup.indexOf('async function setIndependentSiteFeature(feature, on) {');
    const end = popup.indexOf('\nasync function handlePageButtonToggle(on)', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = popup.slice(start, end);
    const pinIndex = handler.indexOf('const pinPromise = on');
    const permissionIndex = handler.indexOf('chrome.permissions.request({origins:[currentSiteOrigin]})');
    const stateAwaitIndex = handler.indexOf('const state = await getState()');
    expect(pinIndex).toBeGreaterThanOrEqual(0);
    expect(permissionIndex).toBeGreaterThan(pinIndex);
    expect(stateAwaitIndex).toBeGreaterThan(permissionIndex);
    expect(handler).toContain('.then(granted => granted === true)');
    expect(handler).toContain('.catch(() => false)');
  });

});

test('latest global redirect toggle choice wins when permission requests resolve out of order', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:false});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body =>
    !body.classList.contains('popup-loading')
  )).toBe(true);

  await page.evaluate(() => {
    const resolvers = [];
    Object.defineProperty(chrome.permissions, 'request', {
      configurable:true,
      value:() => new Promise(resolve => resolvers.push(resolve))
    });
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable:true,
      value:async ({origins = []}) =>
        origins.includes('http://*/*') && origins.includes('https://*/*')
    });
    Object.defineProperty(chrome.tabs, 'query', {
      configurable:true,
      value:async () => []
    });
    window.__redirectPermissionResolvers = resolvers;
    window.__resolveRedirectPermission = (index, granted) => resolvers[index]?.(granted);
  });

  // Keep the first ON request unresolved, then make a newer OFF -> ON choice.
  const olderOn = page.evaluate(() => setRedirect(true));
  await expect.poll(() => page.evaluate(() =>
    window.__redirectPermissionResolvers.length
  )).toBe(1);

  await page.evaluate(() => setRedirect(false));
  const newerOn = page.evaluate(() => setRedirect(true));
  await expect.poll(() => page.evaluate(() =>
    window.__redirectPermissionResolvers.length
  )).toBe(2);

  // Resolve the newer grant first and the older denial last. The older result
  // must not overwrite the user's latest explicit ON choice.
  await page.evaluate(() => window.__resolveRedirectPermission(1, true));
  await newerOn;
  await page.evaluate(() => window.__resolveRedirectPermission(0, false));
  await olderOn;

  const stored = await extensionWorker.evaluate(() =>
    chrome.storage.local.get({redirectEnabled:false})
  );
  expect(stored.redirectEnabled).toBe(true);
});


test('failed redirect-rule refresh rolls a requested global redirect ON choice back to OFF', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:false});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body =>
    !body.classList.contains('popup-loading')
  )).toBe(true);

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.permissions, 'request', {
      configurable:true,
      value:async () => true
    });
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable:true,
      value:async ({origins = []}) =>
        origins.includes('http://*/*') && origins.includes('https://*/*')
    });
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value:message => message?.type === 'blbSuiteRefreshRedirectRules'
        ? Promise.resolve({ok:false, error:'dnr-update-failed'})
        : originalSendMessage(message)
    });
  });

  await page.evaluate(() => setRedirect(true));
  await expect.poll(async () => extensionWorker.evaluate(() =>
    chrome.storage.local.get({redirectEnabled:false})
  )).toMatchObject({redirectEnabled:false});
  await expect(page.locator('#redirectEnabled')).not.toBeChecked();
  await expect(page.locator('#studyStatus')).toContainText(
    'Unable to enable global redirects. The setting remains OFF'
  );
});


test('failed redirect-toggle begin reports that the saved setting is unchanged', async ({
  page, extensionId, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:false});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value:message => message?.type === 'blbSuiteBeginRedirectToggle'
        ? Promise.resolve({ok:false, error:'simulated-begin-failure'})
        : originalSendMessage(message)
    });
  });

  await page.evaluate(() => setRedirect(true));
  await expect(page.locator('#redirectEnabled')).not.toBeChecked();
  await expect(page.locator('#studyStatus')).toContainText(
    'Unable to start the global redirect change. Your previous setting is unchanged'
  );
});

test('failed redirect-toggle commit reports the latest saved setting', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:true});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value:message => message?.type === 'blbSuiteCommitRedirectToggle'
        ? Promise.resolve({ok:false, error:'simulated-commit-failure'})
        : originalSendMessage(message)
    });
  });

  await page.evaluate(() => setRedirect(false));
  // Begin persists the newest intent before commit. A failed/stale commit
  // must therefore show the latest stored value, not claim the prior value
  // was preserved.
  await expect(page.locator('#redirectEnabled')).not.toBeChecked();
  await expect(page.locator('#studyStatus')).toContainText(
    'Unable to confirm the global redirect setting. The latest saved setting is shown'
  );
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:true})).redirectEnabled
  )).toBe(false);
});

test('failed redirect rollback reports that the OFF state could not be confirmed', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:false});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.permissions, 'request', {configurable:true, value:async () => true});
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable:true,
      value:async ({origins = []}) => origins.includes('http://*/*') && origins.includes('https://*/*')
    });
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value:message => {
        if (message?.type === 'blbSuiteRefreshRedirectRules') return Promise.resolve({ok:false});
        if (message?.type === 'blbSuiteCommitRedirectToggle' && message.enabled === false) {
          return Promise.resolve({ok:false, error:'simulated-rollback-failure'});
        }
        return originalSendMessage(message);
      }
    });
  });

  await page.evaluate(() => setRedirect(true));
  await expect(page.locator('#redirectEnabled')).toBeChecked();
  await expect(page.locator('#studyStatus')).toContainText(
    'the OFF rollback could not be confirmed'
  );
  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:false})).redirectEnabled
  )).toBe(true);
});

test('failed current-page activation reports that a reload is needed after redirects are enabled', async ({
  page, extensionId, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:false});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);

  await page.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    Object.defineProperty(chrome.permissions, 'request', {configurable:true, value:async () => true});
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable:true,
      value:async ({origins = []}) => origins.includes('http://*/*') && origins.includes('https://*/*')
    });
    Object.defineProperty(chrome.tabs, 'query', {configurable:true, value:async () => [{id:123}]});
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      configurable:true,
      value:message => message?.type === 'blbSuiteEnsureContentScript'
        ? Promise.resolve({ok:false, error:'simulated-activation-failure'})
        : originalSendMessage(message)
    });
  });

  await page.evaluate(() => setRedirect(true));
  await expect(page.locator('#redirectEnabled')).toBeChecked();
  await expect(page.locator('#studyStatus')).toContainText(
    'Global redirects are enabled, but this page could not be activated. Try reloading the page'
  );
});

test('unsupported active tabs do not report that a reload is required after redirects are enabled', async ({
  page, extensionId, extensionStorage
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:false});
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);

  const unsupportedTab = await page.evaluate(async () => {
    const tab = await chrome.tabs.create({url:'about:blank', active:true});
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    Object.defineProperty(chrome.tabs, 'query', {
      configurable:true,
      value:async query => query?.active && query?.currentWindow
        ? [{id:tab.id, url:'about:blank'}]
        : originalQuery(query)
    });
    Object.defineProperty(chrome.permissions, 'request', {configurable:true, value:async () => true});
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable:true,
      value:async ({origins = []}) => origins.includes('http://*/*') && origins.includes('https://*/*')
    });
    return tab.id;
  });

  try {
    await page.evaluate(() => setRedirect(true));
    await expect(page.locator('#redirectEnabled')).toBeChecked();
    await expect(page.locator('#studyStatus')).toContainText(
      'This page does not support extension activation'
    );
    await expect(page.locator('#studyStatus')).not.toContainText(/reload/i);
  } finally {
    await page.evaluate(async tabId => chrome.tabs.remove(tabId).catch(() => {}), unsupportedTab);
  }
});

test('background redirect-rule refresh reports a Dynamic Rules API failure', async ({
  extensionWorker
}) => {
  const result = await extensionWorker.evaluate(async () => {
    const original = chrome.declarativeNetRequest.updateDynamicRules;
    chrome.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('simulated-dnr-update-failure');
    };
    try {
      return await installRules();
    } finally {
      chrome.declarativeNetRequest.updateDynamicRules = original;
    }
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('simulated-dnr-update-failure');
});


async function runOutOfOrderRedirectRefresh(sourcePath, kind) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../extension', sourcePath), 'utf8');
  const reads = [];
  let onChanged = null;
  let clickHandler = null;
  class FakeElement {}
  const link = kind === 'scripttagger'
    ? {href:'https://www.blueletterbible.org/kjv/jhn/3/16/'}
    : {
        href:'https://www.bibleref.com/John/3/John-3-16.html',
        textContent:'John 3:16-17',
        parentElement:null
      };
  const context = {
    URL,
    Element:FakeElement,
    document:{
      addEventListener(type, handler) {
        if (type === 'click') clickHandler = handler;
      }
    },
    chrome:{
      storage:{
        local:{get:() => new Promise(resolve => reads.push(resolve))},
        onChanged:{addListener(handler) { onChanged = handler; }}
      },
      runtime:{sendMessage:async () => ({ok:true})}
    },
    window:{location:{assign() {}}},
    console:{warn() {}}
  };
  vm.runInNewContext(source, context, {filename:sourcePath});
  expect(reads).toHaveLength(1);

  // Queue an older ON refresh followed by the latest OFF refresh. Resolve OFF
  // first, then let the obsolete ON read finish last.
  onChanged({redirectEnabled:{newValue:true}}, 'local');
  onChanged({redirectEnabled:{newValue:false}}, 'local');
  expect(reads).toHaveLength(3);
  reads[2]({masterEnabled:true,redirectEnabled:false});
  await Promise.resolve();
  reads[0]({masterEnabled:true,redirectEnabled:false});
  await Promise.resolve();
  reads[1]({masterEnabled:true,redirectEnabled:true});
  await new Promise(resolve => setTimeout(resolve, 0));

  const target = new FakeElement();
  target.closest = selector => kind === 'scripttagger'
    ? (selector === 'a.BLBST_a[href]' ? link : null)
    : (selector === 'a[href]' ? link : null);
  const event = {
    button:0, metaKey:false, ctrlKey:false, shiftKey:false, altKey:false,
    target, defaultPrevented:false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() {}
  };
  clickHandler(event);
  return event.defaultPrevented;
}

test('stale ScriptTagger redirect settings cannot override a newer OFF choice', async () => {
  expect(await runOutOfOrderRedirectRefresh('redirect-scripttagger.js', 'scripttagger')).toBe(false);
});

test('stale BibleRef range redirect settings cannot override a newer OFF choice', async () => {
  expect(await runOutOfOrderRedirectRefresh('redirect-bibleref-ranges.js', 'bibleref')).toBe(false);
});

test('initial content-script master and redirect reads cannot override newer storage events', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
  expect(source).toContain('let suiteSettingsGeneration = 0;');
  expect(source).toContain('if (initialSuiteSettingsGeneration === suiteSettingsGeneration)');
  expect(source).toContain('let redirectSettingsGeneration = 0;');
  expect(source).toContain('if (initialRedirectSettingsGeneration !== redirectSettingsGeneration) return;');
  expect(source).toContain('redirectSettingsGeneration += 1;');
  expect(source).toContain('suiteSettingsGeneration += 1;');
});

test('source collectors recheck the current master gate after asynchronous initialization', () => {
  const content = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
  const kings = fs.readFileSync(path.resolve(__dirname, '../../extension/kings-bible-collector.js'), 'utf8');
  const webster = fs.readFileSync(path.resolve(__dirname, '../../extension/webster-collector.js'), 'utf8');
  expect(content).toContain('isSuiteEnabledNow: () => suiteEnabled');
  expect(kings).toContain('isSuiteEnabledNow = isSuiteEnabled');
  expect(kings).toContain('!isSuiteEnabledNow()');
  expect(webster).toContain('if (!(await isSuiteEnabled()) || !isSuiteEnabledNow()) return;');
});

test('pending Study capture stops before recording after global OFF', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../extension/study-reference-capture.js'), 'utf8');
  const activeResolvers = [];
  const captured = [];
  let enabled = true;
  const context = {
    URL,
    location:{
      hostname:'www.blueletterbible.org',
      pathname:'/kjv/jhn/3/16/',
      href:'https://www.blueletterbible.org/kjv/jhn/3/16/'
    },
    document:{readyState:'complete',addEventListener(){}},
    chrome:{
      runtime:{
        sendMessage:message => message?.type === 'blbSuiteStudyCaptureActive'
          ? new Promise(resolve => activeResolvers.push(resolve))
          : (captured.push(message), Promise.resolve({ok:true}))
      }
    }
  };
  vm.runInNewContext(source, context, {filename:'study-reference-capture.js'});
  context.BLBStudyReferenceCaptureModule.initialize({
    BLB_HOSTNAME:'blueletterbible.org',
    normalizeSelectionText:value => String(value || '').trim(),
    isSuiteEnabled:async () => true,
    isSuiteEnabledNow:() => enabled
  });
  await expect.poll(() => activeResolvers.length).toBe(2);
  enabled = false;
  activeResolvers.forEach(resolve => resolve({active:true}));
  for (let i=0;i<6;i++) await Promise.resolve();
  expect(captured).toEqual([]);
});


async function runRedirectMessageFailureFallback(sourcePath, kind) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../extension', sourcePath), 'utf8');
  let clickHandler = null;
  const navigations = [];
  class FakeElement {}
  const link = kind === 'scripttagger'
    ? {href:'https://www.blueletterbible.org/kjv/jhn/3/16/'}
    : {
        href:'https://www.bibleref.com/John/3/John-3-16.html',
        textContent:'John 3:16-17',
        parentElement:null
      };
  const context = {
    URL,
    Element:FakeElement,
    document:{
      addEventListener(type, handler) {
        if (type === 'click') clickHandler = handler;
      }
    },
    chrome:{
      storage:{
        local:{get:async () => ({masterEnabled:true,redirectEnabled:true})},
        onChanged:{addListener() {}}
      },
      runtime:{sendMessage:() => Promise.reject(new Error('simulated disconnected runtime'))}
    },
    window:{location:{assign(url) { navigations.push(url); }}},
    console:{warn() {}}
  };
  vm.runInNewContext(source, context, {filename:sourcePath});
  await new Promise(resolve => setTimeout(resolve, 0));

  const target = new FakeElement();
  target.closest = selector => kind === 'scripttagger'
    ? (selector === 'a.BLBST_a[href]' ? link : null)
    : (selector === 'a[href]' ? link : null);
  const event = {
    button:0, metaKey:false, ctrlKey:false, shiftKey:false, altKey:false,
    target, defaultPrevented:false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() {}
  };
  clickHandler(event);
  await new Promise(resolve => setTimeout(resolve, 0));
  return {defaultPrevented:event.defaultPrevented,navigations};
}

test('ScriptTagger redirect falls back to the original link when runtime messaging rejects', async () => {
  const result = await runRedirectMessageFailureFallback('redirect-scripttagger.js','scripttagger');
  expect(result).toEqual({
    defaultPrevented:true,
    navigations:['https://www.blueletterbible.org/kjv/jhn/3/16/']
  });
});

test('BibleRef range redirect falls back to the original link when runtime messaging rejects', async () => {
  const result = await runRedirectMessageFailureFallback('redirect-bibleref-ranges.js','bibleref');
  expect(result).toEqual({
    defaultPrevented:true,
    navigations:['https://www.bibleref.com/John/3/John-3-16.html']
  });
});

test('a stale redirect permission result in another popup cannot overwrite the latest ON choice', async ({
  page, extensionId, extensionStorage, extensionWorker
}) => {
  await extensionStorage.set({masterEnabled:true, redirectEnabled:false});
  const secondPopup = await page.context().newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await secondPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => page.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);
  await expect.poll(() => secondPopup.locator('body').evaluate(body => !body.classList.contains('popup-loading'))).toBe(true);

  const installPermissionGate = async target => target.evaluate(() => {
    const resolvers = [];
    Object.defineProperty(chrome.permissions, 'request', {
      configurable:true,
      value:() => new Promise(resolve => resolvers.push(resolve))
    });
    Object.defineProperty(chrome.permissions, 'contains', {
      configurable:true,
      value:async ({origins = []}) => origins.includes('http://*/*') && origins.includes('https://*/*')
    });
    Object.defineProperty(chrome.tabs, 'query', {configurable:true, value:async () => []});
    window.__permissionResolvers = resolvers;
  });
  await installPermissionGate(page);
  await installPermissionGate(secondPopup);

  const olderOn = page.evaluate(() => setRedirect(true));
  await expect.poll(() => page.evaluate(() => window.__permissionResolvers.length)).toBe(1);
  const newerOn = secondPopup.evaluate(() => setRedirect(true));
  await expect.poll(() => secondPopup.evaluate(() => window.__permissionResolvers.length)).toBe(1);

  await secondPopup.evaluate(() => window.__permissionResolvers[0](true));
  await newerOn;
  await expect(page.locator('#redirectEnabled')).toBeChecked();
  await page.evaluate(() => window.__permissionResolvers[0](false));
  await olderOn;

  await expect.poll(async () => extensionWorker.evaluate(async () =>
    (await chrome.storage.local.get({redirectEnabled:false})).redirectEnabled
  )).toBe(true);
  await secondPopup.close();
});


test('GitHub and its subdomains are excluded by the shared sensitive-site policy', async ({extensionWorker}) => {
  const result = await extensionWorker.evaluate(async () => ({
    hosts:await Promise.all(['github.com','www.github.com','gist.github.com'].map(async host => ({
      host,
      sensitive:BLBShared.isSensitiveSiteHostname(host),
      scripts:contentScriptFilesForTab({url:'https://'+host+'/arunamalrajmca/blb-suite/tree/main'},{
        masterEnabled:true,
        redirectEnabled:true,
        pageSelectionButtonSites:{[host]:true},
        doubleClickBlbSites:{[host]:true}
      }),
      shouldInject:await shouldInjectContentScriptForTab({url:'https://'+host+'/arunamalrajmca/blb-suite/tree/main'},{
        masterEnabled:true,
        redirectEnabled:true,
        pageSelectionButtonSites:{[host]:true},
        doubleClickBlbSites:{[host]:true}
      }),
      registrationAttempt:await registerRuntimeContentScriptForPattern({url:'https://'+host+'/arunamalrajmca/blb-suite/tree/main'},['redirect-scripttagger.js'])
    })))
  }));
  expect(result.hosts.filter(item => item.host.endsWith('github.com')).every(item => item.sensitive)).toBe(true);
  expect(result.hosts.filter(item => item.host.endsWith('github.com')).every(item => item.scripts.length===0)).toBe(true);
  expect(result.hosts.filter(item => item.host.endsWith('github.com')).every(item => item.shouldInject===false)).toBe(true);
  expect(result.hosts.filter(item => item.host.endsWith('github.com')).every(item => item.registrationAttempt===false)).toBe(true);
});
