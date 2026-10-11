const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../extension/content.js'), 'utf8');
const decodeStart = source.indexOf('function decodeSafe(v) {');
const parseStart = source.indexOf('function parseRef(text) {', decodeStart);
const blbUrlStart = source.indexOf('function blbUrl(', decodeStart);
const redirectStart = source.indexOf('function redirectBibleSite() {', parseStart);
const redirectEnd = source.indexOf('\nfunction redirectBlbNet() {', redirectStart);
if ([decodeStart, blbUrlStart, parseStart, redirectStart, redirectEnd].some(index => index < 0)) {
  throw new Error('Could not locate source-site redirect functions in extension/content.js');
}
// Exclude the production blbUrl() helper entirely so the test's stub is used.
const helpers = source.slice(decodeStart, blbUrlStart) +
  source.slice(parseStart, redirectStart) +
  source.slice(redirectStart, redirectEnd);

function runSourceRedirect(url) {
  let redirectedTo = null;
  const context = {
    URL,
    location: {
      href: url,
      replace(target) { redirectedTo = target; }
    },
    // Isolate URL parsing from the shared book resolver. These tests assert
    // the exact book/chapter/verse/range passed to the destination builder.
    blbUrl(book, chapter, from = 1, to = null) {
      return `https://blb.test/kjv/${String(book).toLowerCase()}/${chapter}/${from}${to ? `-${to}` : ''}/`;
    }
  };
  vm.runInNewContext(helpers + '\nresult = redirectBibleSite();', context);
  return { result: context.result, redirectedTo };
}

test.describe('source Bible URL syntax regression coverage', () => {
  test('Bible Hub general and translation-prefixed verse URLs', () => {
    expect(runSourceRedirect('https://biblehub.com/john/3-16.htm').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16/');
    expect(runSourceRedirect('https://biblehub.com/kjv/john/3-16.htm').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16/');
    expect(runSourceRedirect('https://biblehub.com/esv/john/3-16.htm').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16/');
  });

  test('Bible Hub alternate passage URL preserves a verse range', () => {
    expect(runSourceRedirect('https://biblehub.com/passage/john/3/16-18').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16-18/');
  });

  test('BibleRef commentary path extracts the verse from the repeated chapter slug', () => {
    expect(runSourceRedirect('https://www.bibleref.com/john/3/john-3-16.html').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16/');
    expect(runSourceRedirect('https://www.bibleref.com/john/3/john-3-16-17.html').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16-17/');
  });

  test('BibleRef search URL parses underscore-separated references and ranges', () => {
    expect(runSourceRedirect('https://www.bibleref.com/biblepassage/?search=John_3%3A16-17').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16-17/');
  });

  test('Official King James Bible preserves a verse range', () => {
    expect(runSourceRedirect('https://officialkingjamesbible.com/bible/1-john/3/16-17').redirectedTo)
      .toBe('https://blb.test/kjv/1-john/3/16-17/');
  });

  test('King James Bible Online preserves underscore-separated same-chapter ranges', () => {
    expect(runSourceRedirect('https://kingjamesbibleonline.org/John-3-16_3-17/').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16-17/');
  });

  test('translation selection does not alter the BLB KJV destination', () => {
    expect(runSourceRedirect('https://www.bible.com/bible/111/JHN.3.16-21.niv').redirectedTo)
      .toBe('https://blb.test/kjv/jhn/3/16-21/');
    expect(runSourceRedirect('https://www.bibleportal.com/verse-topic?v=john+3%3A16&version=NIV').redirectedTo)
      .toBe('https://blb.test/kjv/john/3/16/');
  });
});
