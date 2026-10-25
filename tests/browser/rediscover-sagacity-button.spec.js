const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

test('Sagacity collector recovers full references from BLB preSearch URLs', () => {
  expect(content).toContain('if (sourceSite === "sagacity")');
  expect(content).toContain('targetUrl.searchParams.get("Criteria")');
  expect(content).toContain('targetHost === "blueletterbible.org"');
  expect(content).toContain('/^\\/search\\/preSearch\\.cfm$/i.test(targetUrl.pathname)');
  expect(content).toContain('String(targetUrl.searchParams.get("Criteria") || "").replace(/\\+/g, " ")');
  expect(content).toContain('if (/^Matt\\.?$/i.test(value)) return "Matthew";');
  expect(content).toContain('normalizeSourceBibleBook(sagacityCriteriaReference.book)');
});

test('Sagacity dotted BLB Criteria resolves Matt. 12.37 as Matthew 12:37', () => {
  const extract = source => {
    const match = content.match(source);
    expect(match, 'expected helper declaration in production source').not.toBeNull();
    return match[0];
  };
  const helpers = vm.runInNewContext([
    extract(/function decodeSafe\\(v\\) \\{[\\s\\S]*?\\n\\}/),
    extract(/function parseRef\\(text\\) \\{[\\s\\S]*?\\n\\}/),
    extract(/function normalizeSourceBibleBook\\(book\\) \\{[\\s\\S]*?\\n\\}/),
    '({ parseRef, normalizeSourceBibleBook })'
  ].join('\\n'));
  const target = new URL('https://www.blueletterbible.org/search/preSearch.cfm?Criteria=Matt.+12.37&t=ESV');
  const criteria = target.searchParams.get('Criteria').replace(
    /^(.*?)\\s+(\\d+)\\.(\\d+(?:-\\d+)?)$/,
    '$1 $2:$3'
  );
  const parsed = helpers.parseRef(criteria);
  expect(parsed).toEqual({ book: 'Matt', chapter: 12, from: 37, to: null });
  expect(helpers.normalizeSourceBibleBook(parsed.book)).toBe('Matthew');
});

test('Sagacity BLB Criteria remains a fallback and does not replace valid captions', () => {
  const collector = content.slice(content.indexOf('function collectSourcePageBibleReferences'));
  const captionFallback = collector.indexOf('if (!parsed) parsed = parseRef(label);');
  const criteriaFallback = collector.indexOf('if (!parsed) parsed = sagacityCriteriaReference;');
  const resolutionFallback = collector.indexOf('if (!resolved && sourceSite === "sagacity" && sagacityCriteriaReference)');
  expect(captionFallback).toBeGreaterThan(-1);
  expect(criteriaFallback).toBeGreaterThan(captionFallback);
  expect(resolutionFallback).toBeGreaterThan(criteriaFallback);
});
