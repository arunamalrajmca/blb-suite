const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
const booksSource = fs.readFileSync(path.resolve(__dirname, '../../extension/books.js'), 'utf8');
const aliasesSource = fs.readFileSync(path.resolve(__dirname, '../../extension/book-aliases.js'), 'utf8');
const referenceCoreSource = fs.readFileSync(path.resolve(__dirname, '../../extension/reference-core.js'), 'utf8');
const sharedPatternsSource = fs.readFileSync(path.resolve(__dirname, '../../extension/regex-patterns.js'), 'utf8');
const decodeStart = source.indexOf('function decodeSafe(v) {');
const bookKeyStart = source.indexOf('function bookKey(value) {');
const parseStart = source.indexOf('function parseRef(text) {', decodeStart);
const blbUrlStart = source.indexOf('function blbUrl(', decodeStart);
const redirectStart = source.indexOf('function redirectBibleSite() {', parseStart);
const redirectEnd = source.indexOf('\nfunction redirectBlbNet() {', redirectStart);
if ([decodeStart, bookKeyStart, blbUrlStart, parseStart, redirectStart, redirectEnd].some(index => index < 0)) {
  throw new Error('Could not locate source-site redirect functions in extension/content.js');
}
// Exercise the production book table, alias resolver, reference validator, and URL builder.
const helpers = sharedPatternsSource + '\n' + booksSource + '\n' + aliasesSource + '\n' + referenceCoreSource + '\n' +
  source.slice(bookKeyStart, parseStart) +
  source.slice(parseStart, redirectStart) + source.slice(redirectStart, redirectEnd);

function runSourceRedirect(url) {
  let redirectedTo = null;
  let openedInNewTab = null;
  const context = {
    URL,
    location: {
      href: url,
      replace(target) { redirectedTo = target; }
    },
    openBlbDestinationFromContent(target) { openedInNewTab = target; },
    // No blbUrl stub: this calls the real production resolver.

  };
  vm.runInNewContext(helpers + '\nresult = redirectBibleSite();', context);
  return { result: context.result, redirectedTo, openedInNewTab };
}

test.describe('source Bible URL syntax regression coverage', () => {
  test('Bible Hub general and translation-prefixed verse URLs', () => {
    expect(runSourceRedirect('https://biblehub.com/john/3-16.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://biblehub.com/kjv/john/3-16.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://biblehub.com/esv/john/3-16.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('Bible Hub alternate passage URL preserves a verse range', () => {
    expect(runSourceRedirect('https://biblehub.com/passage/john/3/16-18').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
  });

  test('BibleRef commentary path extracts the verse from the repeated chapter slug', () => {
    expect(runSourceRedirect('https://www.bibleref.com/john/3/john-3-16.html').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://www.bibleref.com/john/3/john-3-16-17.html').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-17/');
  });

  test('BibleRef search URL parses underscore-separated references and ranges', () => {
    expect(runSourceRedirect('https://www.bibleref.com/biblepassage/?search=John_3%3A16-17').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-17/');
  });

  test('Official King James Bible preserves a verse range', () => {
    expect(runSourceRedirect('https://officialkingjamesbible.com/bible/1-john/3/16-17').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/3/16-17/');
  });

  test('King James Bible Online preserves underscore-separated same-chapter ranges', () => {
    expect(runSourceRedirect('https://kingjamesbibleonline.org/John-3-16_3-17/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-17/');
  });

  test('Christianity.com homepage is excluded; chapter, verse, and range routes open BLB in a new tab', () => {
    for (const url of [
      'https://www.christianity.com/',
      'https://www.christianity.com/bible/',
      'https://www.christianity.com/bible/help/passage-search-basics/'
    ]) {
      expect(runSourceRedirect(url).openedInNewTab, url).toBeNull();
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
    }
    expect(runSourceRedirect('https://www.christianity.com/bible/esv/ephesians/2').openedInNewTab)
      .toBe('https://www.blueletterbible.org/kjv/eph/2/1/');
    expect(runSourceRedirect('https://www.christianity.com/bible/esv/john/3-16').openedInNewTab)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://www.christianity.com/bible/niv%2Cesv/1-john/3-16-21').openedInNewTab)
      .toBe('https://www.blueletterbible.org/kjv/1jo/3/16-21/');
    expect(runSourceRedirect('https://christianity.com/bible/esv/2-corinthians/5-17').openedInNewTab)
      .toBe('https://www.blueletterbible.org/kjv/2co/5/17/');
    for (const url of [
      'https://www.christianity.com/bible/esv/ephesians/2',
      'https://www.christianity.com/bible/esv/john/3-16',
      'https://www.christianity.com/bible/niv%2Cesv/1-john/3-16-21'
    ]) {
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
    }
    for (const url of [
      'https://www.christianity.com/bible/esv/john/0',
        'https://www.christianity.com/bible/esv/john/3-18-16',
      'https://www.christianity.com/bible/esv/not-a-book/3-16',
      'https://www.christianity.com/bible/esv/john/999-1'
    ]) {
      expect(runSourceRedirect(url).openedInNewTab, url).toBeNull();
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
    }
  });

  test('ESV.org supports root-level chapters, verses, ranges, and /verses/ references', () => {
    expect(runSourceRedirect('https://www.esv.org/Ephesians+2/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/eph/2/1/');
    expect(runSourceRedirect('https://www.esv.org/Ephesians%2B2/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/eph/2/1/');
    expect(runSourceRedirect('https://esv.org/John+3%3A16/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://www.esv.org/John+3%3A16-18/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
    expect(runSourceRedirect('https://www.esv.org/verses/John%2B3%3A16/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
    expect(runSourceRedirect('https://esv.org/verses/John%2B3%3A16-18/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
    expect(runSourceRedirect('https://www.esv.org/verses/Psalm%2B23/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
    for (const url of [
      'https://www.esv.org/',
      'https://www.esv.org/about/',
      'https://www.esv.org/resources/esv-crossreference-tool/'
    ]) {
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
      expect(runSourceRedirect(url).openedInNewTab, url).toBeNull();
    }
  });

  test('translation selection does not alter the BLB KJV destination', () => {
    expect(runSourceRedirect('https://www.bible.com/bible/111/JHN.3.16-21.niv').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-21/');
    expect(runSourceRedirect('https://www.bibleportal.com/verse-topic?v=john+3%3A16&version=NIV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('Bible.com single verse, chapter, and range formats always target KJV', () => {
    expect(runSourceRedirect('https://www.bible.com/bible/111/GEN.1.1.niv').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/gen/1/1/');
    expect(runSourceRedirect('https://www.bible.com/bible/1/PSA.23.niv').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
    expect(runSourceRedirect('https://www.bible.com/bible/111/1JN.4.7-8.esv').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/4/7-8/');
  });

  test('BibleGateway passage search supports single verses, ranges, and ignored versions', () => {
    expect(runSourceRedirect('https://www.biblegateway.com/passage/?search=Romans%208%3A28&version=NIV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/rom/8/28/');
    expect(runSourceRedirect('https://biblegateway.com/passage/?version=ESV&search=1%20John%204%3A7-8').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/4/7-8/');
    expect(runSourceRedirect('https://biblegateway.com/passage/?search=Psalm%2023&version=KJV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
  });

  test('Bible Hub supports single verses, chapters, and ranges in standard and translation paths', () => {
    expect(runSourceRedirect('https://biblehub.com/genesis/1.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/gen/1/1/');
    expect(runSourceRedirect('https://biblehub.com/john/3-16-18.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
    expect(runSourceRedirect('https://biblehub.com/niv/1_john/4-7-8.htm').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/4/7-8/');
  });

  test('King James Bible Online supports chapter routes, compact chapter routes, and repeated leading slashes', () => {
    expect(runSourceRedirect('https://kingjamesbibleonline.org/John-Chapter-3/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/John-Chapter-1_Original-1611-KJV/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/1/1/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/' + '/John-Chapter-3/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/Psalms-23/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
  });

  test('King James Bible Online preserves verse ranges and numbered book names', () => {
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/John-3-16-18/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16-18/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/1-John-4-7-8/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/1jo/4/7-8/');
  });

  test('KJBO alias hostname is checked separately from the main domain', () => {
    expect(runSourceRedirect('https://kjbo.org/John-3-16/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('KJV.site supports chapter and verse routes independently of www', () => {
    expect(runSourceRedirect('https://kjv.site/John-3-kjv/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
    expect(runSourceRedirect('https://www.kjv.site/John-3-16-kjv/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/16/');
  });

  test('BiblePortal supports its alternate reference parameter and version ordering', () => {
    expect(runSourceRedirect('https://bibleportal.com/verse-topic?verse-topic=Matthew.5.3-5&version=ESV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/mat/5/3-5/');
    expect(runSourceRedirect('https://www.bibleportal.com/verse-topic?v=Psalm%2023&version=NKJV').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/psa/23/1/');
  });

  test("The King's Bible maps home, Strong's entries, dictionary/concordance, and passages", () => {
    expect(runSourceRedirect('https://www.thekingsbible.com/').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary#').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Concordance').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Concordance#').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/StrongsNo/H3811').redirectedTo).toBe('https://www.blueletterbible.org/lexicon/h3811/kjv/wlc/0-1/');
    expect(runSourceRedirect('https://www.thekingsbible.com/Bible/18/4?verse=5').redirectedTo).toBe('https://www.blueletterbible.org/kjv/job/4/5/');
    expect(runSourceRedirect('https://www.thekingsbible.com/Bible/3/1').redirectedTo).toBe('https://www.blueletterbible.org/kjv/lev/1/1/');
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary/Habakkuk').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary/Habitation').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Dictionary/').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Concordance/beautify').redirectedTo).toBeNull();
    expect(runSourceRedirect('https://www.thekingsbible.com/Concordance/').redirectedTo).toBeNull();
  });

  test('unsupported and malformed source URLs do not redirect', () => {
    expect(runSourceRedirect('https://biblehub.com/not-a-book/abc.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://biblehub.com/john/3-16-18-20.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://example.com/john/3-16.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://biblegateway.com/search/?search=John%203%3A16').redirectedTo).toBe(null);
  });


  test('new source redirects require an exact supported hostname, not a lookalike domain or subdomain', () => {
    for (const url of [
      'https://notchristianity.com/bible/esv/john/3-16',
      'https://christianity.com.example.test/bible/esv/john/3-16',
      'https://blog.christianity.com/bible/esv/john/3-16',
      'https://not-esv.org/John+3%3A16/',
      'https://esv.org.example.test/John+3%3A16/',
      'https://blog.esv.org/John+3%3A16/'
    ]) {
      expect(runSourceRedirect(url).redirectedTo, url).toBeNull();
      expect(runSourceRedirect(url).openedInNewTab, url).toBeNull();
    }
  });

});


test('table-driven source redirect matrix preserves validated destinations across supported URL families', () => {
  const cases = [
    ['Bible.com translation-prefixed range', 'https://www.bible.com/bible/111/1JN.4.7-8.esv', 'https://www.blueletterbible.org/kjv/1jo/4/7-8/'],
    ['BibleGateway search with ignored translation', 'https://www.biblegateway.com/passage/?search=Romans%208%3A28&version=NIV', 'https://www.blueletterbible.org/kjv/rom/8/28/'],
    ['BibleRef commentary range', 'https://www.bibleref.com/john/3/john-3-16-17.html', 'https://www.blueletterbible.org/kjv/jhn/3/16-17/'],
    ['Bible Hub alternate passage range', 'https://biblehub.com/passage/john/3/16-18', 'https://www.blueletterbible.org/kjv/jhn/3/16-18/'],
    ['Christianity.com passage opens a new tab', 'https://www.christianity.com/bible/esv/john/3-16', 'https://www.blueletterbible.org/kjv/jhn/3/16/', 'newTab'],
    ['ESV encoded plus-sign range', 'https://www.esv.org/verses/John%2B3%3A16-18/', 'https://www.blueletterbible.org/kjv/jhn/3/16-18/'],
    ['BiblePortal dotted book and range', 'https://bibleportal.com/verse-topic?verse-topic=Matthew.5.3-5&version=ESV', 'https://www.blueletterbible.org/kjv/mat/5/3-5/'],
    ['King James Bible Online underscore range', 'https://kingjamesbibleonline.org/John-3-16_3-17/', 'https://www.blueletterbible.org/kjv/jhn/3/16-17/'],
    ['King James Bible Online chapter route', 'https://www.kingjamesbibleonline.org/John-Chapter-3/', 'https://www.blueletterbible.org/kjv/jhn/3/1/'],
    ['KJV.site verse route', 'https://kjv.site/John-3-16-kjv/', 'https://www.blueletterbible.org/kjv/jhn/3/16/'],
    ['KJV.site mobile subdomain verse route', 'https://m.kjv.site/John-3-16-kjv/', 'https://www.blueletterbible.org/kjv/jhn/3/16/'],
    ['Official King James Bible numbered book range', 'https://officialkingjamesbible.com/bible/1-john/3/16-17', 'https://www.blueletterbible.org/kjv/1jo/3/16-17/'],
    ["The King's Bible numeric book and query verse", 'https://www.thekingsbible.com/Bible/18/4?verse=5', 'https://www.blueletterbible.org/kjv/job/4/5/'],
    ["The King's Bible Strong's entry", 'https://www.thekingsbible.com/StrongsNo/H3811', 'https://www.blueletterbible.org/lexicon/h3811/kjv/wlc/0-1/']
  ];

  for (const [label, url, expected, mode] of cases) {
    const result = runSourceRedirect(url);
    const actual = mode === 'newTab' ? result.openedInNewTab : result.redirectedTo;
    expect(actual, label + ': ' + url).toBe(expected);
    if (mode === 'newTab') expect(result.redirectedTo, label).toBeNull();
  }
});

test('single verse boundaries normalize consistently across source hosts', () => {
  const cases = [
    ['Bible Hub verse zero', 'https://biblehub.com/john/3-0.htm', 'https://www.blueletterbible.org/kjv/jhn/3/1/'],
    ['Bible Hub verse above chapter maximum', 'https://biblehub.com/john/3-999.htm', 'https://www.blueletterbible.org/kjv/jhn/3/36/'],
    ['KJV.site mobile verse zero', 'https://m.kjv.site/John-3-0-kjv/', 'https://www.blueletterbible.org/kjv/jhn/3/1/']
  ];
  for (const [label, url, expected] of cases) {
    expect(runSourceRedirect(url).redirectedTo, label).toBe(expected);
  }
});

test('table-driven malformed reference matrix refuses unsafe or ambiguous destinations', () => {
  const cases = [
    'https://biblehub.com/not-a-book/abc.htm',
    'https://biblehub.com/john/3-16-18-20.htm',
    'https://biblegateway.com/search/?search=John%203%3A16',
    'https://www.christianity.com/bible/esv/john/3-18-16',
    'https://kjv.site/not-a-book-3-16-kjv/',
    'https://m.kjv.site/John-3-16-18-20-kjv/',
    'https://notchristianity.com/bible/esv/john/3-16',
    'https://christianity.com.example.test/bible/esv/john/3-16',
    'https://blog.esv.org/John+3%3A16/'
  ];

  for (const url of cases) {
    const result = runSourceRedirect(url);
    expect(result.redirectedTo, url).toBeNull();
    expect(result.openedInNewTab, url).toBeNull();
  }
});
