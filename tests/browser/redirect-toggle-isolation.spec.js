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
    expect(handler).toContain("setPageButton(!!on)");
    expect(handler).toContain("setDoubleClick(!!on)");
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
  await Promise.resolve();
  await Promise.resolve();

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
