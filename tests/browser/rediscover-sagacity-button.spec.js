const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const content = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
const sourceCollector = fs.readFileSync(path.join(root, 'extension/source-page-collector.js'), 'utf8');

test('Rediscover, Sagacity, and TSK use the existing current-page MultiVerse collector', () => {
  expect(sourceCollector).toContain('"rediscover.bible":"rediscover"');
  expect(sourceCollector).toContain('"sagacityweb.com":"sagacity"');
  expect(sourceCollector).toContain('"thetreasuryofscriptureknowledge.com":"treasury"');
  expect(sourceCollector).toContain('"thetreasuryofscriptureknowledge.com":"treasury"');
  expect(sourceCollector).toContain('if (sourceSite && !isSourceHomepage)');
  expect(sourceCollector).toContain('document.querySelectorAll("a[href]")');
  expect(sourceCollector).toContain('openSourcePageBibleReferencesInMultiVerse');
});

test('Sagacity collector recovers full references from BLB preSearch URLs', () => {
  expect(sourceCollector).toContain('if (sourceSite === "sagacity")');
  expect(sourceCollector).toContain('targetUrl.searchParams.get("Criteria")');
  expect(sourceCollector).toContain('targetHost === "blueletterbible.org"');
  expect(sourceCollector).toContain('/^\\/search\\/preSearch\\.cfm$/i.test(targetUrl.pathname)');
  expect(sourceCollector).toContain('String(targetUrl.searchParams.get("Criteria") || "").replace(/\\+/g, " ")');
  expect(content).toContain('if (/^Matt\\.?$/i.test(value)) return "Matthew";');
  expect(sourceCollector).toContain('normalizeSourceBibleBook(sagacityCriteriaReference.book)');
});

test('Sagacity dotted BLB Criteria resolves Matt. 12.37 as Matthew 12:37', () => {
  const extractFunction = name => {
    const start = content.indexOf('function ' + name + '(');
    expect(start, 'expected ' + name + ' helper in production source').toBeGreaterThan(-1);
    const end = content.indexOf('\n}', start) + 2;
    expect(end).toBeGreaterThan(start + 2);
    return content.slice(start, end);
  };
  const helpers = vm.runInNewContext([
    extractFunction('decodeSafe'),
    extractFunction('parseRef'),
    extractFunction('normalizeSourceBibleBook'),
    '({ parseRef, normalizeSourceBibleBook })'
  ].join('\n'));
  const target = new URL('https://www.blueletterbible.org/search/preSearch.cfm?Criteria=Matt.+12.37&t=ESV');
  const criteria = target.searchParams.get('Criteria').replace(
    /^(.*?)\s+(\d+)\.(\d+(?:-\d+)?)$/,
    '$1 $2:$3'
  );
  const parsed = helpers.parseRef(criteria);
  expect(parsed).toEqual({ book: 'Matt', chapter: 12, from: 37, to: null });
  expect(helpers.normalizeSourceBibleBook(parsed.book)).toBe('Matthew');
});

test('Sagacity BLB Criteria remains a fallback and does not replace valid captions', () => {
  const collector = sourceCollector.slice(sourceCollector.indexOf('function collectSourcePageBibleReferences'));
  const captionFallback = collector.indexOf('if (!parsed) parsed = parseRef(label);');
  const criteriaFallback = collector.indexOf('if (!parsed) parsed = sagacityCriteriaReference;');
  const resolutionFallback = collector.indexOf('if (!resolved && sourceSite === "sagacity" && sagacityCriteriaReference)');
  expect(captionFallback).toBeGreaterThan(-1);
  expect(criteriaFallback).toBeGreaterThan(captionFallback);
  expect(resolutionFallback).toBeGreaterThan(criteriaFallback);
});

test('Sagacity browser collector captures Matt. 12:37 from malformed nested BLB anchors', async ({ page }) => {
  const extractFunction = (source, name) => {
    const start = source.indexOf('function ' + name + '(');
    expect(start, 'expected ' + name + ' helper in source').toBeGreaterThan(-1);
    const end = source.indexOf('\n}', start) + 2;
    expect(end).toBeGreaterThan(start + 2);
    return source.slice(start, end);
  };
  const collectorStart = sourceCollector.indexOf('function collectSourcePageBibleReferences()');
  expect(collectorStart).toBeGreaterThan(-1);
  const collectorEnd = content.indexOf('\n    }\n\n    function showSourcePageMultiVerseStatus', collectorStart);
  expect(collectorEnd).toBeGreaterThan(collectorStart);
  const collectorSource = content.slice(collectorStart, collectorEnd + '\n    }'.length);

  await page.setContent(`
    <main>
      <p>
        <a href="https://www.blueletterbible.org/search/preSearch.cfm?Criteria=Matt.+12.37&amp;t=ESV"><a href="https://www.blueletterbible.org/search/preSearch.cfm?Criteria=Matt.+12.37&amp;t=NLT" rel="NLT.Matt.12.37" class="BLBST_a" style="white-space: nowrap;">Matt. 12:37</a></a>
      </p>
    </main>
  `);
  // Use the real Bible book table and reference resolver in the browser.
  await page.addScriptTag({ path: path.join(root, 'extension/books.js') });
  await page.addScriptTag({ path: path.join(root, 'extension/book-aliases.js') });
  await page.addScriptTag({ path: path.join(root, 'extension/reference-core.js') });

  const helpers = [
    extractFunction(content, 'normalizeSelectionText'),
    extractFunction(content, 'decodeSafe'),
    extractFunction(content, 'parseRef'),
    extractFunction(content, 'bookKey'),
    extractFunction(content, 'blbUrl'),
    extractFunction(content, 'normalizeSourceBibleBook'),
    extractFunction(content, 'formatSourceBibleBookName'),
    collectorSource
  ].join('\n');
  const refs = await page.evaluate(helperSource => {
    const collect = new Function(
      'sourceSite', 'buttonId',
      helperSource + '\nreturn collectSourcePageBibleReferences;'
    )('sagacity', 'test-collector-button');
    return collect();
  }, helpers);

  expect(refs.some(ref =>
    ref.book.toLowerCase() === 'matthew' &&
    ref.chapter === 12 &&
    ref.from === 37 &&
    (ref.to == null || ref.to === 37)
  )).toBe(true);
});
