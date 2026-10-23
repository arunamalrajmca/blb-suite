const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const contentSource = read('extension/content.js');

test.describe("The King's Bible study-link routing", () => {
  test('content handler recognizes Bible URLs without relying on popup CSS selectors', async ({ page }) => {
    const helperStart = contentSource.indexOf('function theKingsBibleLinkReference(link) {');
    const helperEnd = contentSource.indexOf('\n\n  document.addEventListener("click"', helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);

    await page.route('https://www.thekingsbible.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Fixture</title>' }));
    await page.goto('https://www.thekingsbible.com/Dictionary/Face');
    await page.addScriptTag({ content: read('extension/regex-patterns.js') });
    await page.addScriptTag({ content: 'const BLB_HOSTNAME = BLBShared.hostnames.blb;' });
    await page.addScriptTag({ content: read('extension/books.js') });
    await page.addScriptTag({ content: read('extension/book-aliases.js') });
    await page.addScriptTag({ content: read('extension/reference-core.js') });
    await page.addScriptTag({ content: 'function normalizeSelectionText(s) { return String(s || "").trim(); } function parseRef() { return null; }' });
    await page.addScriptTag({ content: contentSource.slice(helperStart, helperEnd) });

    const results = await page.evaluate(() => {
      const make = href => {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = 'verse';
        return theKingsBibleLinkReference(link);
      };
      return {
        pathVerse: make('/Bible/43/3/16'),
        queryVerse: make('/Bible/43/3?verse=16'),
        fragmentVerse: make('/Bible/43/3#verse_16'),
        chapterOnly: make('/Bible/43/3'),
        outsideHost: make('https://example.com/Bible/43/3/16')
      };
    });

    expect(results.pathVerse).toMatchObject({book: 'John', chapter: 3, from: 16, to: null});
    expect(results.queryVerse).toMatchObject({book: 'John', chapter: 3, from: 16, to: null});
    expect(results.fragmentVerse).toMatchObject({book: 'John', chapter: 3, from: 16, to: null});
    expect(results.chapterOnly).toMatchObject({book: 'John', chapter: 3, from: 1, to: null});
    expect(results.outsideHost).toBeNull();
  });

  test('Dictionary span.bible data-bible values resolve to their exact KJV references', async ({ page }) => {
    const helperStart = contentSource.indexOf('function theKingsBibleDataReference(node) {');
    const helperEnd = contentSource.indexOf('\n\n  function theKingsBibleLinkReference', helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);

    await page.route('https://www.thekingsbible.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Fixture</title>' }));
    await page.goto('https://www.thekingsbible.com/Dictionary/Face');
    await page.addScriptTag({ content: read('extension/books.js') });
    await page.addScriptTag({ content: contentSource.slice(helperStart, helperEnd) });

    const results = await page.evaluate(() => {
      const make = id => {
        const span = document.createElement('span');
        span.className = 'bible';
        span.setAttribute('data-bible', id);
        return theKingsBibleDataReference(span);
      };
      return {
        genesis319: make('1003019'),
        genesis4811: make('1048011'),
        ezekiel4114: make('26041014'),
        psalms3116: make('19031016'),
        psalms131: make('19013001'),
        acts2516: make('44025016'),
        corinthians1312: make('46013012'),
        invalid: make('abc')
      };
    });

    expect(results.genesis319).toMatchObject({book: 'Genesis', chapter: 3, from: 19, to: null});
    expect(results.genesis4811).toMatchObject({book: 'Genesis', chapter: 48, from: 11, to: null});
    expect(results.ezekiel4114).toMatchObject({book: 'Ezekiel', chapter: 41, from: 14, to: null});
    expect(results.psalms3116).toMatchObject({book: 'Psalms', chapter: 31, from: 16, to: null});
    expect(results.psalms131).toMatchObject({book: 'Psalms', chapter: 13, from: 1, to: null});
    expect(results.acts2516).toMatchObject({book: 'Acts', chapter: 25, from: 16, to: null});
    expect(results.corinthians1312).toMatchObject({book: '1 Corinthians', chapter: 13, from: 12, to: null});
    expect(results.invalid).toBeNull();
  });

  test('Strong’s routing is delegated for exact G/H tokens and is not popup-selector dependent', () => {
    const start = contentSource.indexOf('// ---------- The King\'s Bible Strong\'s and Bible-reference links ----------');
    const end = contentSource.indexOf('// ---------- Webster\'s 1828 ----------', start);
    expect(start).toBeGreaterThanOrEqual(0);
    const handler = contentSource.slice(start, end);
    expect(handler).toContain('document.addEventListener("click", e =>');
    expect(handler).toContain('label.match(/^([GH]');
    expect(handler).toContain('https://www.blueletterbible.org/lexicon/');
    expect(handler).not.toContain('isStudyPopupLink');
  });
});
