const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const content = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');

test('Rediscover, Sagacity, and TSK use the existing current-page MultiVerse collector', () => {
  expect(content).toContain('"rediscover.bible":"rediscover"');
  expect(content).toContain('"sagacityweb.com":"sagacity"');
  expect(content).toContain('"thetreasuryofscriptureknowledge.com":"treasury"');
  expect(content).toContain("'rediscover.bible', 'sagacityweb.com', 'thetreasuryofscriptureknowledge.com'");
  expect(content).toContain('if (sourceSite && !isSourceHomepage)');
  expect(content).toContain('document.querySelectorAll("a[href]")');
  expect(content).toContain('openSourcePageBibleReferencesInMultiVerse');
});
