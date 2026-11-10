const { test, expect } = require('@playwright/test');
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
      permissions: { contains: async ({origins:requested}) => requested.every(origin =>
        origins.includes(origin) || origins.includes('https://*/*') || origins.includes('http://*/*')
      ) }
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

  test('explicit site preferences enable their features when host access is granted', async () => {
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
    expect(handler).toContain("pinSiteFeatureChoice(feature, otherFeatureEnabled)");

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
