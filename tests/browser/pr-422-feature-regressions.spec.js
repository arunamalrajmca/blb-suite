const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const contentSource = read('extension/content.js');
const popupSource = read('extension/popup.html');
const popupJsSource = read('extension/popup.js');
const tutorialSource = read('extension/Tutorial.html');

function extractFunction(source, declaration, nextDeclaration) {
  const start = source.indexOf(declaration);
  const end = source.indexOf(nextDeclaration, start);
  if (start < 0 || end < 0) {
    throw new Error(`Unable to extract ${declaration}`);
  }
  return source.slice(start, end);
}

function kingsBibleLinkTarget(href) {
  const fn = extractFunction(
    contentSource,
    'function theKingsBibleLinkTarget(href) {',
    '\nif (location.hostname?.toLowerCase().replace(/^www\\./, "") === "thekingsbible.com"'
  );
  const books = [
    { name: 'Leviticus', bookNumber: 3, urlKey: 'lev' },
    { name: 'Job', bookNumber: 18, urlKey: 'job' }
  ];
  const context = {
    URL,
    location: { href: 'https://www.thekingsbible.com/Dictionary/Test' },
    BLBShared: { urls: { blbOrigin: 'https://www.blueletterbible.org' } },
    BOOKS: books,
    blbUrl(book, chapter, verse) {
      const found = books.find(item => item.name.toLowerCase() === String(book).toLowerCase());
      if (!found || !Number.isInteger(chapter) || chapter < 1 ||
          !Number.isInteger(verse) || verse < 1) return null;
      return `https://www.blueletterbible.org/kjv/${found.urlKey}/${chapter}/${verse}/`;
    }
  };
  vm.runInNewContext(fn + '\nresult = theKingsBibleLinkTarget(input);', { ...context, input: href });
  return vm.runInNewContext(fn + '\nresult = theKingsBibleLinkTarget(input);', { ...context, input: href });
}

test.describe("The King's Bible redirect regressions", () => {
  test('maps Strong’s links and normalizes leading zeroes', () => {
    expect(kingsBibleLinkTarget('/StrongsNo/H03811'))
      .toBe('https://www.blueletterbible.org/lexicon/h3811/kjv/wlc/0-1/');
    expect(kingsBibleLinkTarget('https://thekingsbible.com/StrongsNo/G00025/'))
      .toBe('https://www.blueletterbible.org/lexicon/g25/kjv/tr/0-1/');
  });

  test('maps numeric Bible passage links and defaults missing verse to one', () => {
    expect(kingsBibleLinkTarget('/Bible/18/4?verse=5'))
      .toBe('https://www.blueletterbible.org/kjv/job/4/5/');
    expect(kingsBibleLinkTarget('/Bible/3/1'))
      .toBe('https://www.blueletterbible.org/kjv/lev/1/1/');
  });

  test('rejects foreign hosts, unknown books, and unrelated paths', () => {
    expect(kingsBibleLinkTarget('https://example.com/Bible/18/4?verse=5')).toBeNull();
    expect(kingsBibleLinkTarget('/Bible/999/4?verse=5')).toBeNull();
    expect(kingsBibleLinkTarget('/Dictionary/Habakkuk')).toBeNull();
    expect(kingsBibleLinkTarget('/Concordance/beautify')).toBeNull();
  });

  test('invalid verse parameters safely fall back to verse one', () => {
    expect(kingsBibleLinkTarget('/Bible/18/4?verse=5x'))
      .toBe('https://www.blueletterbible.org/kjv/job/4/1/');
    expect(kingsBibleLinkTarget('/Bible/18/4?verse=%3Cscript%3E'))
      .toBe('https://www.blueletterbible.org/kjv/job/4/1/');
  });
});

test.describe("The King's Bible entry-page click handling", () => {
  test('is restricted to entry routes and respects the redirect and master switches', () => {
    expect(contentSource).toMatch(/location\.hostname\?\.toLowerCase\(\)\.replace\(\/\^www\\\.\/\s*,\s*["']["']\) === ["']thekingsbible\.com["']/);
    expect(contentSource).toMatch(/if \(!theKingsBibleRedirectEnabled \|\| !suiteEnabled\) return;/);
    expect(contentSource).toMatch(/if \(event\.defaultPrevented \|\| isModifiedLinkActivation\(event\)\) return;/);
    expect(contentSource).toContain('anchor.hasAttribute("download")');
  });

  test('handles visible book references, abbreviated data-bible IDs, verse ranges, and Judges source IDs', () => {
    expect(contentSource).toContain('element.getAttribute("data-bible")');
    expect(contentSource).toContain('const abbreviatedLabel = /^\\d+:\\d+(?:-\\d+)?$/');
    expect(contentSource).toContain('const visibleRange = label.match(/^(\\d+):(\\d+)-(\\d+)$/)');
    expect(contentSource).toContain('bookCode === "65"');
    expect(contentSource).toContain('resolveBibleReference(bookName, chapter, from, to)');
  });

  test('preserves the full non-contiguous verse list when opening MultiVerse', () => {
    expect(contentSource).toContain('type: "blbSuiteOpenWebsterMultiVerse", refs');
    expect(contentSource).toContain('const listMatch = referenceText.match(/^(\\d+);(\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*)$/)');
    expect(contentSource).toContain('refs.length === verseItems.length && refs.length > 1');
  });
});

test.describe("The King's Bible MultiVerse collector regressions", () => {
  test('uses source-specific selectors for Concordance versus Dictionary entries', () => {
    expect(contentSource).toContain("'#ConcordanceTable a.concordanceitem[href^=\"/Bible/\"], a.concordanceitem[href^=\"/Bible/\"]'");
    expect(contentSource).toContain('".bible[data-bible], a.bible"');
    expect(contentSource).toContain('const kingsBibleEntryType = kingsBibleEntryMatch[1].toLowerCase()');
  });

  test('reads numbered pagination controls, caps probing, and deduplicates collected references', () => {
    expect(contentSource).toContain('ul.pagination li.current-page a');
    expect(contentSource).toContain('Math.min(lastPage, 20)');
    expect(contentSource).toContain('const pageCount = pageNumbers.length ? Math.min(lastPage, 20) : 10');
    expect(contentSource).toContain('while (pending.length && visited.size < 20)');
    expect(contentSource).toContain('if (seen.has(ref.url)) continue');
    expect(contentSource).toContain('fetch(pageUrl, { credentials: "same-origin" })');
  });

  test('does not collect all Dictionary pages as though they were paginated Concordance results', () => {
    expect(contentSource).toContain('if (kingsBibleEntryType !== "concordance")');
    expect(contentSource).toContain('return collectKingsBibleReferences(document, location.href)');
  });

  test('creates one visible button and removes it when the master setting is disabled', () => {
    expect(contentSource).toContain('id = "blb-suite-kingsbible-multiverse"');
    expect(contentSource).toContain('document.getElementById("blb-suite-kingsbible-multiverse")');
    expect(contentSource).toContain('document.getElementById("blb-suite-kingsbible-multiverse")?.remove()');
    expect(contentSource).toContain('Open Bible References in BLB');
  });
});

test.describe('Gospel content and Study deletion safety regressions', () => {
  test('popup includes clickable Gospel references and the full 2 Timothy 2:15 KJV footer', () => {
    expect(popupSource).toContain('The Gospel of Salvation');
    expect(popupSource).toContain('https://www.blueletterbible.org/kjv/1co/15/1-4/');
    expect(popupSource).toContain('https://www.blueletterbible.org/kjv/eph/2/8-9/');
    expect(popupSource).toContain('2 Timothy 2:15 (KJV)');
    expect(popupSource).toContain('https://columbusbiblechurch.org/');
  });

  test('tutorial includes Gospel/right-division content and the recommended study links', () => {
    expect(tutorialSource).toContain('The Gospel of Salvation');
    expect(tutorialSource).toContain('1 Corinthians 15:1–4');
    expect(tutorialSource).toContain('Ephesians 2:8–9');
    expect(tutorialSource).toContain('https://columbusbiblechurch.org/');
    expect(tutorialSource).toContain('https://www.youtube.com/@ColumbusBibleChurch');
    expect(tutorialSource).toContain('2 Timothy 2:15 (KJV)');
  });

  test('individual topic and all-data deletion warn users to export a backup first', () => {
    expect(popupJsSource).toContain('Export a Study backup to keep its notes and references.');
    expect(popupJsSource).toContain('Export a Study backup first to keep its notes and references.');
    expect(popupJsSource).toContain('Delete all Study data? Export a backup first to keep a copy.');
  });

  test('cancel paths remain before destructive Study messages are sent', () => {
    expect(popupJsSource).toMatch(/if \(!confirm\([\s\S]*?\)\) return;[\s\S]{0,250}blbSuiteClearStudyTopic/);
    expect(popupJsSource).toMatch(/if \(!confirm\('Delete all Study data\?[\s\S]*?\)\) return;[\s\S]{0,180}blbSuiteClearStudy/);
  });
});
