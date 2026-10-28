const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popup = fs.readFileSync(path.resolve(__dirname, '../../extension/popup.js'), 'utf8');

function runSiteAccessHelper(origins) {
  const start = popup.indexOf('async function hasSiteFeatureHostAccess(origin) {');
  const end = popup.indexOf('\nasync function getState()', start);
  if (start < 0 || end < 0) throw new Error('Could not extract hasSiteFeatureHostAccess from extension/popup.js');
  const context = {
    chrome: { permissions: { getAll: async () => ({ origins }) } }
  };
  vm.runInNewContext(popup.slice(start, end), context);
  return context.hasSiteFeatureHostAccess;
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
  test('wildcard redirect grants do not activate per-site features', async () => {
    const hasSiteFeatureHostAccess = runSiteAccessHelper(['http://*/*', 'https://*/*']);
    expect(await hasSiteFeatureHostAccess('https://sagacityweb.com/*')).toBe(false);
  });

  test('a specific site grant still authorizes its site features', async () => {
    const hasSiteFeatureHostAccess = runSiteAccessHelper([
      'http://*/*',
      'https://*/*',
      'https://sagacityweb.com/*'
    ]);
    expect(await hasSiteFeatureHostAccess('https://sagacityweb.com/*')).toBe(true);
  });
  test('turning either site feature ON or OFF applies the paired preference', () => {
    const start = popup.indexOf('async function setSiteFeaturesEnabled(on) {');
    const end = popup.indexOf("\nasync function handlePageButtonToggle(on)", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = popup.slice(start, end);
    expect(handler).toContain('setPageButton(!!on)');
    expect(handler).toContain('setDoubleClick(!!on)');
    expect(popup.slice(popup.indexOf('async function handlePageButtonToggle(on) {'), popup.indexOf("\ndocument.getElementById('pageButton').addEventListener")))
      .toContain('setSiteFeaturesEnabled(on)');
    expect(popup.slice(popup.indexOf('async function handleDoubleClickToggle(on) {'), popup.indexOf("\ndocument.getElementById('pageButton').addEventListener")))
      .toContain('setSiteFeaturesEnabled(on)');
  });

  test('existing broad permission is reused without requesting a redundant site grant', async () => {
    const start = popup.indexOf('async function requestCurrentSiteAccess(');
    const end = popup.indexOf('\n\nasync function setPageButton', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const calls = [];
    const context = {
      chrome: { permissions: {
        contains: async details => { calls.push(['contains', details]); return true; },
        request: async details => { calls.push(['request', details]); return true; }
      }}
    };
    vm.runInNewContext(popup.slice(start, end), context);
    expect(await context.requestCurrentSiteAccess('https://sagacityweb.com/*')).toBe(true);
    expect(calls.map(call => call[0])).toEqual(['contains']);
  });

});
