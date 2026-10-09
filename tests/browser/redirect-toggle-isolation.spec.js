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
});
