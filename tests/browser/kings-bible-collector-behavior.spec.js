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
        return anchors.filter(anchor => anchor.getAttribute('data-bible') != null || /\bbible\b/i.test(anchor.getAttribute('class') || ''));
      }
    }, url);
}


function allPagesCollectorFor(pages, startUrl) {
  const start = contentSource.indexOf('function collectKingsBibleReferences(');
  const end = contentSource.indexOf('\n  function showKingsBibleStatus(', start);
  expect(start, 'Kings Bible collector must exist').toBeGreaterThan(-1);
  expect(end, 'Kings Bible all-pages collector boundary must exist').toBeGreaterThan(start);
  const collectorSource = contentSource.slice(start, end);
  const location = new URL(startUrl);
  const fetched = [];
  const context = {
    kingsBibleEntryType: 'concordance',
    BOOKS: books,
    URL,
    location,
    document: pages.get(startUrl),
    normalizeSelectionText,
    parseRef,
    resolveBibleReference,
    blbUrl,
    fetch: async url => {
      fetched.push(url);
      const page = pages.get(url);
      return page
        ? { ok: true, text: async () => '<mocked page>' }
        : { ok: false, text: async () => '' };
    },
    DOMParser: class {
      parseFromString() {
        const url = fetched[fetched.length - 1];
        return pages.get(url);
      }
    }
  };
  vm.runInNewContext(collectorSource + '\nthis.__collectAll = collectAllKingsBibleReferences;', context);
  return { collect: () => context.__collectAll(), fetched };
}

function makeConcordancePage({ entries = [], pageLinks = [], pageNumbers = [] } = {}) {
  const entryAnchors = entries.map(entry => makeAnchor({
    href: entry.href,
    text: entry.text || '',
    className: 'concordanceitem'
  }));
  const paginationAnchors = pageNumbers.map(number => makeAnchor({
    href: '#',
    text: String(number)
  }));
  const otherAnchors = pageLinks.map(link => makeAnchor({
    href: link.href,
    text: link.text
  }));
  const allAnchors = [...entryAnchors, ...paginationAnchors, ...otherAnchors];
  return {
    querySelectorAll(selector) {
      if (selector === 'ul.pagination li.current-page a') return paginationAnchors;
      if (selector === 'a[href]') return allAnchors;
      if (selector.includes('concordanceitem')) return entryAnchors;
      return [];
    }
  };
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
      text: 'Exodus 4:14'
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
      text: 'Judges 6:15-17'
    });
    expect(refs[0].url).toBe('https://www.blueletterbible.org/kjv/judges/6/15/17/');
  });

  test('Concordance fetches numbered pages, deduplicates references across pages, and respects the page cap', async () => {
    const startUrl = 'https://www.thekingsbible.com/Concordance/faith/1';
    const secondUrl = 'https://www.thekingsbible.com/Concordance/faith/2';
    const thirdUrl = 'https://www.thekingsbible.com/Concordance/faith/3';
    const firstPage = makeConcordancePage({
      entries: [
        { href: '/Bible/1/1?verse=1', text: 'Genesis 1:1' }
      ],
      pageNumbers: [1, 2, 3],
      pageLinks: [{ href: '/Concordance/faith/2', text: 'Next' }]
    });
    const secondPage = makeConcordancePage({
      entries: [
        { href: '/Bible/1/1?verse=1', text: 'Genesis 1:1 duplicate' },
        { href: '/Bible/2/4?verse=14', text: 'Exodus 4:14' }
      ],
      pageNumbers: [1, 2, 3],
      pageLinks: [{ href: '/Concordance/faith/3', text: '3' }]
    });
    const thirdPage = makeConcordancePage({
      entries: [{ href: '/Bible/7/6?verse=15', text: 'Judges 6:15' }],
      pageNumbers: [1, 2, 3]
    });
    const pages = new Map([[startUrl, firstPage], [secondUrl, secondPage], [thirdUrl, thirdPage]]);
    const harness = allPagesCollectorFor(pages, startUrl);

    const refs = await harness.collect();
    expect(refs.map(ref => ref.text)).toEqual(['Genesis 1:1', 'Exodus 4:14', 'Judges 6:15']);
    expect(new Set(refs.map(ref => ref.url)).size).toBe(3);
    expect(harness.fetched).toContain(secondUrl);
    expect(harness.fetched).toContain(thirdUrl);
    expect(harness.fetched.filter(url => url === secondUrl)).toHaveLength(1);
  });

});
