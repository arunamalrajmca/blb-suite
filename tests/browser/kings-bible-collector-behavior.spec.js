const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const contentSource = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');

const books = [
  { name: 'Genesis', bookNumber: 1 },
  { name: 'Exodus', bookNumber: 2 },
  { name: 'Judges', bookNumber: 7 }
];

function normalizeSelectionText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseRef(value) {
  const match = normalizeSelectionText(value).match(/^(Genesis|Exodus|Judges)\s+(\d+):(\d+)(?:-(\d+))?$/i);
  if (!match) return null;
  const book = books.find(item => item.name.toLowerCase() === match[1].toLowerCase());
  return { book: book.name, chapter: Number(match[2]), from: Number(match[3]), to: match[4] ? Number(match[4]) : null };
}

function resolveBibleReference(bookName, chapter, from, to) {
  const book = books.find(item => item.name.toLowerCase() === String(bookName || '').toLowerCase());
  if (!book || !Number.isInteger(Number(chapter)) || Number(chapter) < 1 ||
      !Number.isInteger(Number(from)) || Number(from) < 1 ||
      (to != null && (!Number.isInteger(Number(to)) || Number(to) < Number(from)))) return null;
  return { book, chapter: Number(chapter), from: Number(from), to: to == null ? null : Number(to) };
}

function blbUrl(book, chapter, from, to) {
  const item = resolveBibleReference(book, chapter, from, to);
  if (!item) return null;
  const key = item.book.name.toLowerCase();
  return `https://www.blueletterbible.org/kjv/${key}/${item.chapter}/${item.from}/${item.to == null ? '' : item.to + '/'}`;
}

function makeAnchor({ href = '', text = '', dataBible = null, className = '' }) {
  const attrs = { href, 'data-bible': dataBible, class: className };
  return {
    textContent: text,
    getAttribute(name) { return attrs[name] == null ? null : String(attrs[name]); }
  };
}

function collectorFor(type, anchors) {
  const start = contentSource.indexOf('function collectKingsBibleReferences(');
  const end = contentSource.indexOf('\n  async function collectAllKingsBibleReferences()', start);
  expect(start, 'Kings Bible collector must exist').toBeGreaterThan(-1);
  expect(end, 'Kings Bible collector boundary must exist').toBeGreaterThan(start);
  const collectorSource = contentSource.slice(start, end).trim();
  const context = {
    kingsBibleEntryType: type,
    BOOKS: books,
    URL,
    normalizeSelectionText,
    parseRef,
    resolveBibleReference,
    blbUrl
  };
  vm.runInNewContext(collectorSource + '\nthis.__collector = collectKingsBibleReferences;', context);
  return (url = 'https://www.thekingsbible.com/' + (type === 'concordance' ? 'Concordance/faith' : 'Dictionary/test')) =>
    context.__collector({
      querySelectorAll(selector) {
        if (type === 'concordance') {
          return anchors.filter(anchor => String(anchor.getAttribute('href') || '').startsWith('/Bible/'));
        }
        return anchors.filter(anchor => anchor.getAttribute('data-bible') != null || /\\bbible\\b/i.test(anchor.getAttribute('class') || ''));
      }
    }, url);
}

test.describe("The King's Bible MultiVerse collector behavior", () => {
  test('Concordance uses the structured Bible URL when a caption is malformed and deduplicates equivalent targets', () => {
    const collect = collectorFor('concordance', [
      makeAnchor({ href: '/Bible/2/4?verse=14', text: 'unparseable caption' }),
      makeAnchor({ href: '/Bible/2/4?verse=14', text: 'Exodus 4:14' }),
      makeAnchor({ href: '/Dictionary/Exodus', text: 'Exodus 4:14' }),
      makeAnchor({ href: '/Bible/999/4?verse=14', text: 'unparseable caption' })
    ]);

    const refs = collect();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      book: 'Exodus',
      bookNumber: 2,
      chapter: 4,
      from: 14,
      to: null,
      version: 'kjv',
      text: 'unparseable caption'
    });
    expect(refs[0].url).toBe('https://www.blueletterbible.org/kjv/exodus/4/14/');
  });

  test('Dictionary preserves a meaningful caption when the reference is parsed from visible text', () => {
    const collect = collectorFor('dictionary', [
      makeAnchor({ href: '/Dictionary/test', text: 'Genesis 1:1', className: 'bible' })
    ]);

    const refs = collect();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      book: 'Genesis',
      chapter: 1,
      from: 1,
      to: null,
      text: 'Genesis 1:1'
    });
  });

  test('Dictionary resolves an abbreviated data-bible verse range without treating the page as paginated Concordance', () => {
    const collect = collectorFor('dictionary', [
      makeAnchor({ href: '/Bible/7/6?verse=15', text: '6:15-17', dataBible: '65006015', className: 'bible' }),
      makeAnchor({ href: '/Bible/7/6?verse=15', text: '6:15-17', dataBible: '65006015', className: 'bible' }),
      makeAnchor({ href: '/Dictionary/other', text: 'not a reference', className: 'bible' })
    ]);

    const refs = collect();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      book: 'Judges',
      bookNumber: 7,
      chapter: 6,
      from: 15,
      to: 17,
      version: 'kjv',
      text: '6:15-17'
    });
    expect(refs[0].url).toBe('https://www.blueletterbible.org/kjv/judges/6/15/17/');
  });
});
