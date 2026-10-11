const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
const booksSource = fs.readFileSync(path.resolve(__dirname, '../../extension/books.js'), 'utf8');
const aliasesSource = fs.readFileSync(path.resolve(__dirname, '../../extension/book-aliases.js'), 'utf8');
const referenceCoreSource = fs.readFileSync(path.resolve(__dirname, '../../extension/reference-core.js'), 'utf8');
const decodeStart = source.indexOf('function decodeSafe(v) {');
const parseStart = source.indexOf('function parseRef(text) {', decodeStart);
const blbUrlStart = source.indexOf('function blbUrl(', decodeStart);
const redirectStart = source.indexOf('function redirectBibleSite() {', parseStart);
const redirectEnd = source.indexOf('\nfunction redirectBlbNet() {', redirectStart);
if ([decodeStart, blbUrlStart, parseStart, redirectStart, redirectEnd].some(index => index < 0)) {
  throw new Error('Could not locate source-site redirect functions in extension/content.js');
}
// Exercise the production book table, alias resolver, reference validator, and URL builder.
const helpers = booksSource + '\n' + aliasesSource + '\n' + referenceCoreSource + '\n' +
  source.slice(source.indexOf('function bookKey(value) {'), parseStart) +
  source.slice(parseStart, redirectStart) + source.slice(redirectStart, redirectEnd);

function runSourceRedirect(url) {
  let redirectedTo = null;
  const context = {
    URL,
    location: {
      href: url,
      replace(target) { redirectedTo = target; }
    },
    // No blbUrl stub: this calls the real production resolver.

  };
  vm.runInNewContext(helpers + '\nresult = redirectBibleSite();', context);
  return { result: context.result, redirectedTo };
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

  test('King James Bible Online supports chapter routes, repeated leading slashes, and the kjbo.org alias', () => {
    expect(runSourceRedirect('https://kingjamesbibleonline.org/John-Chapter-3/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
    expect(runSourceRedirect('https://www.kingjamesbibleonline.org/' + '/John-Chapter-3/').redirectedTo)
      .toBe('https://www.blueletterbible.org/kjv/jhn/3/1/');
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

  test('unsupported and malformed source URLs do not redirect', () => {
    expect(runSourceRedirect('https://biblehub.com/not-a-book/abc.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://biblehub.com/john/3-16-18-20.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://example.com/john/3-16.htm').redirectedTo).toBe(null);
    expect(runSourceRedirect('https://biblegateway.com/search/?search=John%203%3A16').redirectedTo).toBe(null);
  });

});
