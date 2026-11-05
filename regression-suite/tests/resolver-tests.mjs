export function registerResolverTests(context) {
  const { test, section, read, loadPure, fixture, expectedVersion, ROOT, assert, fs, path, vm, bg, content } = context;
section('resolver');
// Shared Bible-reference core + production selection extractor.
const refCtx = loadPure(['books.js','book-aliases.js','reference-core.js']);
// Top-level const declarations in vm contexts are lexical bindings, not ctx properties.
const refBooks = vm.runInContext('BOOKS', refCtx);
const refBookAliases = vm.runInContext('BOOK_ALIASES', refCtx);
const bgSource = read('background.js');
test('shared alias source is authoritative for Omnibox and reference resolver', () => {
  const aliasSource = vm.runInContext('EXTRA_BOOK_ALIASES', refCtx);
  const aliasMap = vm.runInContext('BOOK_ALIASES', refCtx);
  assert(aliasSource && Object.keys(aliasSource).length > 0, 'shared alias source is empty');
  const expectedAliases = Object.create(null);
  for (const [alias, target] of Object.entries(aliasSource)) {
    const book = refBooks.find(item => item.name === target);
    assert(book, `alias source target is not a canonical book: ${alias}`);
    const normalized = String(alias).toLowerCase().trim();
    const canonical = String(book.name || '').toLowerCase().trim();
    const urlKey = String(book.urlKey || '').toLowerCase().trim();
    const number = String(book.bookNumber || '').trim();
    if (normalized && normalized !== canonical && normalized !== urlKey && normalized !== number) {
      expectedAliases[normalized] = target;
    }
  }
  assert.deepEqual(aliasMap, expectedAliases, 'derived alias map diverges from shared source');
  for (const [alias, target] of Object.entries(expectedAliases)) {
    assert.equal(refCtx.resolveBibleBook(alias)?.name, target, `reference resolver mismatch: ${alias}`);
    const refs = refCtx.resolveBibleReferenceText(`${alias} 1:1`);
    assert.equal(refs.length, 1, `reference grammar mismatch: ${alias}`);
    assert.equal(refs[0].book, target, `reference grammar target mismatch: ${alias}`);
  }
  assert(bgSource.includes('importScripts(') && bgSource.includes("'kjv-corpus-word-index.js'"), 'background import list missing');
  assert(bgSource.includes("'book-aliases.js'"), 'background does not import shared alias source');
  assert(bgSource.includes('bookData.forEach(book => { book.aliases = buildBookAliases(book); });'), 'Omnibox book aliases are not built from shared source');
  assert(bgSource.includes('const explicitAlias = BOOK_ALIASES[base] || BOOK_ALIASES[base.replace(/\\s/g,"")];'), 'Omnibox resolver does not use shared alias map');
  assert.equal((read('book-aliases.js').match(/const EXTRA_BOOK_ALIASES\s*=/g) || []).length, 1, 'duplicate alias source detected');
  assert(!read('reference-core.js').includes('const EXTRA_BOOK_ALIASES'), 'reference resolver contains a duplicate alias source');
});

const extractorStart = bgSource.indexOf('function extractBibleRefsFromSelectedTextUncached');
const extractorEnd = bgSource.indexOf('\nfunction ', extractorStart + 10);
vm.runInContext(bgSource.slice(extractorStart, extractorEnd > extractorStart ? extractorEnd : undefined), refCtx, {filename:'background.js:extractBibleRefsFromSelectedTextUncached'});

test('shared core resolves every numbered Bible-book family', () => {
  for (const book of refBooks.filter(book => /^[123] /.test(book.name))) {
    const refs = refCtx.resolveBibleReferenceText(`${book.name} 1:1`);
    assert.equal(refs.length, 1, book.name);
    assert.equal(refs[0].book, book.name, book.name);
    assert.equal(refs[0].chapter, 1, book.name);
    assert.equal(refs[0].from, 1, book.name);
    assert.equal(refs[0].to, 1, book.name);
  }
});
test('shared core normalizes URL-style book separators generically', () => {
  const forms = [
    ['1-John', '1 john'],
    ['1_john', '1 john'],
    ['1-John', '1 john'],
    ['2-Samuel', '2 samuel'],
    ['1_Corinthians', '1 corinthians'],
    ['Song-of-Solomon', 'song of solomon'],
    ['Song_of_Solomon', 'song of solomon']
  ];
  for (const [form, expected] of forms) {
    const book = refCtx.resolveBibleBook(form);
    assert.equal(book?.name, expected, form);
  }
  for (const book of refBooks) {
    const hyphenated = book.name.replace(/ /g, '-');
    const underscored = book.name.replace(/ /g, '_');
    assert.equal(refCtx.resolveBibleBook(hyphenated)?.name, book.name, hyphenated);
    assert.equal(refCtx.resolveBibleBook(underscored)?.name, book.name, underscored);
  }
});

test('reference grammar preserves chapter, verse, and range after URL-style book normalization', () => {
  const cases = [
    ['1-John 5:1-3', '1 john', 5, 1, 3],
    ['1_john 5:1', '1 john', 5, 1, 1],
    ['2-Samuel 12:7-9', '2 samuel', 12, 7, 9],
    ['2_Timothy 3:16-17', '2 timothy', 3, 16, 17],
    ['Song-of-Solomon 2:1-3', 'song of solomon', 2, 1, 3]
  ];
  for (const [input, book, chapter, from, to] of cases) {
    const refs = refCtx.resolveBibleReferenceText(input);
    assert.equal(refs.length, 1, input);
    assert.deepEqual(
      [refs[0].book, refs[0].chapter, refs[0].from, refs[0].to],
      [book, chapter, from, to],
      input
    );
  }
});
test('production selection extractor resolves every Roman-numeral numbered book family', () => {
  const roman = {1: 'I', 2: 'II', 3: 'III'};
  const numbered = refBooks.filter(book => /^[123] /.test(book.name));
  assert(numbered.length > 0);
  for (const book of numbered) {
    const prefix = Number(book.name[0]);
    const form = `${roman[prefix]} ${book.name.slice(2)} 1:1`;
    const refs = refCtx.extractBibleRefsFromSelectedTextUncached(form);
    assert.equal(refs.length, 1, `${form}: ${refs.map(ref => ref.text).join(' | ')}`);
    assert.equal(refs[0].book, book.name, form);
    assert.equal(refs[0].chapter, 1, form);
    assert.equal(refs[0].from, 1, form);
    assert.equal(refs[0].to, 1, form);
  }
  for (const prefix of [...new Set(numbered.map(book => roman[Number(book.name[0])]))]) {
    assert.equal(refCtx.extractBibleRefsFromSelectedTextUncached(prefix).length, 0, `standalone ${prefix} must remain unresolved`);
  }
});
test('multi-reference paragraph extraction covers every numbered book family', () => {
  const roman = {1: 'I', 2: 'II', 3: 'III'};
  const numbered = refBooks.filter(book => /^[123] /.test(book.name));
  const source = numbered.map((book, index) => {
    const prefix = Number(book.name[0]);
    const chapter = (index % book.chapterCount) + 1;
    return `${roman[prefix]} ${book.name.slice(2)} ${chapter}:1`;
  }).join('; ');
  const refs = refCtx.extractBibleRefsFromSelectedTextUncached(source);
  assert.equal(refs.length, numbered.length, refs.map(ref => ref.text).join(' | '));
  refs.forEach((ref, index) => {
    const book = numbered[index];
    assert.equal(ref.book, book.name, book.name);
    assert.equal(ref.chapter, (index % book.chapterCount) + 1, book.name);
    assert.equal(ref.from, 1, book.name);
    assert.equal(ref.to, 1, book.name);
  });
});
test('generic double-click reference grammar resolves all 66 books and every shared alias', () => {
  const books = refBooks;
  assert.equal(books.length, 66);
  const aliasesByBook = Object.create(null);
  for (const [alias, target] of Object.entries(refBookAliases || {})) {
    (aliasesByBook[target] ||= []).push(alias);
  }

  for (const book of books) {
    const canonicalForms = [book.name, book.urlKey];
    const aliases = aliasesByBook[book.name] || [];
    const forms = [...new Set([...canonicalForms, ...aliases])];

    for (const form of forms) {
      const variants = [
        [`${form} 1:1`, 1, 1, 1],
        [`${form} 1:1-2`, 1, 1, 2],
        [`${form} 1.1`, 1, 1, 1],
        [`${form} 1 1`, 1, 1, 1]
      ];
      if (book.chapterCount > 1) variants.push([`${form} 1`, 1, null, null]);
      if (book.chapterCount === 1) variants.push([`${form} 1-2`, 1, 1, 2]);

      for (const [input, chapter, from, to] of variants) {
        const refs = refCtx.resolveBibleReferenceText(input);
        assert.equal(refs.length, 1, `${book.name}: ${input}`);
        assert.equal(refs[0].book, book.name, `${book.name}: ${input}`);
        assert.equal(refs[0].chapter, chapter, `${book.name}: ${input}`);
        if (from !== null) assert.equal(refs[0].from, from, `${book.name}: ${input}`);
        if (to !== null) assert.equal(refs[0].to, to, `${book.name}: ${input}`);
      }
    }
  }

  // Numbered-book Roman forms are tested from the same 66-book source of truth.
  const roman = {1:'I',2:'II',3:'III'};
  for (const book of books.filter(b => /^[123] /.test(b.name))) {
    const n = Number(book.name[0]);
    const remainder = book.name.slice(2);
    const form = `${roman[n]} ${remainder} 1:1`;
    const refs = refCtx.resolveBibleReferenceText(form);
    assert.equal(refs.length, 1, form);
    assert.equal(refs[0].book, book.name, form);
  }

  // Standalone numbers outside the book-number domain must not become books.
  for (const value of ['0','67','68','150','176','99999']) {
    assert.equal(refCtx.resolveBibleBook(value), null, `standalone ${value}`);
  }
  assert.equal(refCtx.resolveBibleBook('I'), null, 'standalone I');
  assert.equal(refCtx.resolveBibleBook('II'), null, 'standalone II');
  assert.equal(refCtx.resolveBibleBook('III'), null, 'standalone III');
});

test('property-based reference grammar generation covers deterministic valid and invalid forms', () => {
  // Deterministic property-style generation: the seed and source-of-truth data
  // make failures reproducible while exercising many combinations beyond the
  // hand-authored matrix above.
  const books = refBooks;
  const aliasesByBook = Object.create(null);
  for (const [alias, target] of Object.entries(refBookAliases || {})) {
    (aliasesByBook[target] ||= []).push(alias);
  }

  let seed = 0x5a17;
  const next = (max) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  };
  const forms = [];
  for (const book of books) {
    forms.push(book.name, book.urlKey);
    for (const alias of aliasesByBook[book.name] || []) forms.push(alias);
  }

  const syntax = [
    (form, ch, verse) => `${form} ${ch}:${verse}`,
    (form, ch, verse) => `${form} ${ch}.${verse}`,
    (form, ch, verse) => `${form} ${ch} ${verse}`,
    (form, ch) => `${form} ${ch}`
  ];

  for (let i = 0; i < 600; i++) {
    const form = forms[next(forms.length)];
    const book = books.find(b =>
      b.name === form ||
      b.urlKey === form ||
      String(b.bookNumber) === form ||
      (aliasesByBook[b.name] || []).includes(form)
    );
    assert(book, `generated form has no source book: ${form}`);

    const chapter = 1 + next(book.chapterCount);
    const verse = 1 + next(8);
    const formatter = syntax[next(syntax.length)];
    const input = formatter(form, chapter, verse);
    const refs = refCtx.resolveBibleReferenceText(input);

    assert.equal(refs.length, 1, `generated reference: ${input}`);
    assert.equal(refs[0].book, book.name, `generated book: ${input}`);
    assert.equal(refs[0].chapter, chapter, `generated chapter: ${input}`);
    if (formatter.length >= 3) assert.equal(refs[0].from, verse, `generated verse: ${input}`);
  }

  for (const invalid of ['0:1', '67:1', '68:1', '999:1', 'I 1:1', 'II 1:1', 'III 1:1']) {
    assert.equal(refCtx.resolveBibleReferenceText(invalid).length, 0, `invalid generated form: ${invalid}`);
  }
});

test('direct reference resolver rejects prose and accepts exact refs', () => {
  assert(refCtx.resolveDirectBibleReference('1 Thessalonians 2:13'));
  assert.equal(refCtx.resolveDirectBibleReference('in every one'), null);
  // Roman numeral handling belongs to the production selection extractor, not the pure core.
  assert(refCtx.extractBibleRefsFromSelectedTextUncached('I Thessalonians 2:13').length === 1);
});


}
